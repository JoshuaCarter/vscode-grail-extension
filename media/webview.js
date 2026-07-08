(function () {
  const vscode = acquireVsCodeApi();

  const filterInput = document.getElementById('filterInput');
  const filterClearBtn = document.getElementById('filterClearBtn');
  const regexToggle = document.getElementById('regexToggle');
  const caseToggle = document.getElementById('caseToggle');
  const lineLimitInput = document.getElementById('lineLimitInput');
  const clearBtn = document.getElementById('clearBtn');
  const statusText = document.getElementById('statusText');
  const jumpBar = document.getElementById('jumpBar');
  const jumpBtn = document.getElementById('jumpBtn');
  const scrollArea = document.getElementById('scrollArea');
  const content = document.getElementById('content');

  let rawLines = [];
  let following = true;
  let currentFilePath = null;
  let pendingLines = null;
  let pendingStartLine = null;
  // Absolute (1-based) line number of rawLines[0] in the file on disk.
  let startLine = 1;
  const SCROLL_EPS = 24;

  // content.innerHTML gets fully replaced on every render, which destroys any active
  // browser text selection. While the user has text selected inside the log, incoming
  // updates are held back instead of being rendered immediately, so copying text stays
  // stable even while new lines keep arriving in the background.
  function hasActiveSelectionInContent() {
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && content.contains(sel.anchorNode);
  }

  function applyIncomingLines(lines, newStartLine, force) {
    if (!force && hasActiveSelectionInContent()) {
      pendingLines = lines;
      pendingStartLine = newStartLine;
      statusText.textContent = 'Selection active \u2014 new lines paused (click elsewhere to resume)';
      return;
    }
    pendingLines = null;
    pendingStartLine = null;
    if (force) {
      window.getSelection()?.removeAllRanges();
    }
    rawLines = lines;
    if (typeof newStartLine === 'number') {
      startLine = newStartLine;
    }
    render();
  }

  document.addEventListener('selectionchange', () => {
    if (pendingLines && !hasActiveSelectionInContent()) {
      const lines = pendingLines;
      const newStartLine = pendingStartLine;
      pendingLines = null;
      pendingStartLine = null;
      rawLines = lines;
      if (typeof newStartLine === 'number') {
        startLine = newStartLine;
      }
      render();
    }
  });

  function selectAllContent() {
    const range = document.createRange();
    range.selectNodeContents(content);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Ctrl/Cmd+A anywhere in the panel selects only the visible log lines, instead of the
  // browser default of selecting the whole page (toolbar labels, buttons, status text).
  // The filter and line-limit text fields keep their native select-all-within-field behavior.
  document.addEventListener('keydown', (e) => {
    const isSelectAllCombo = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a';
    if (!isSelectAllCombo) {
      return;
    }
    const active = document.activeElement;
    if (active === filterInput || active === lineLimitInput) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    selectAllContent();
    // Electron/VS Code's native "Select All" menu accelerator can fire independently of
    // this handler and override the selection above with a whole-page select. Re-apply
    // on the next tick so ours wins even when that happens.
    setTimeout(selectAllContent, 0);
  });

  // Restoring a persisted view (e.g. after a window reload/restart): re-apply the
  // last filter/toggle values before the first render. The file to tail and its line
  // limit are read from this same state by the extension host's webview serializer.
  const previousState = vscode.getState() || {};
  if (typeof previousState.filterText === 'string') {
    filterInput.value = previousState.filterText;
  }
  if (typeof previousState.useRegex === 'boolean') {
    regexToggle.checked = previousState.useRegex;
  }
  if (typeof previousState.caseSensitive === 'boolean') {
    caseToggle.checked = previousState.caseSensitive;
  }

  function persistState() {
    vscode.setState({
      filePath: currentFilePath,
      lineLimit: Number(lineLimitInput.value) || undefined,
      filterText: filterInput.value,
      useRegex: regexToggle.checked,
      caseSensitive: caseToggle.checked
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Builds a global RegExp from the filter bar: plain text is treated as a literal
  // substring search (like grep -F), /pattern/flags is treated as a real regex, and
  // the ".*" toggle forces regex mode for the plain text as well.
  function buildMatcher() {
    const raw = filterInput.value;
    if (!raw) {
      return null;
    }

    let pattern = raw;
    let flags = caseToggle.checked ? '' : 'i';
    let useRegex = regexToggle.checked;

    const slashMatch = raw.match(/^\/(.*)\/([a-z]*)$/i);
    if (slashMatch) {
      useRegex = true;
      pattern = slashMatch[1];
      flags = slashMatch[2] || (caseToggle.checked ? '' : 'i');
    }

    try {
      const source = useRegex ? pattern : escapeRegExp(pattern);
      const finalFlags = flags.includes('g') ? flags : flags + 'g';
      return new RegExp(source, finalFlags);
    } catch (e) {
      return null;
    }
  }

  // Matches against the raw line first, then escapes each segment as it is emitted,
  // so HTML-escaping never shifts match offsets computed from the unescaped text.
  function highlightLine(line, matcher) {
    if (!matcher) {
      return { html: escapeHtml(line), matched: true };
    }
    matcher.lastIndex = 0;
    let html = '';
    let lastIndex = 0;
    let matched = false;
    let m;
    while ((m = matcher.exec(line)) !== null) {
      matched = true;
      html += escapeHtml(line.slice(lastIndex, m.index));
      html += '<mark>' + escapeHtml(m[0]) + '</mark>';
      lastIndex = m.index + m[0].length;
      if (m[0].length === 0) {
        matcher.lastIndex++;
        if (matcher.lastIndex > line.length) {
          break;
        }
      }
    }
    html += escapeHtml(line.slice(lastIndex));
    return { html, matched };
  }

  function updateFilterClearVisibility() {
    filterClearBtn.classList.toggle('hidden', filterInput.value.length === 0);
  }

  function render() {
    updateFilterClearVisibility();
    const matcher = buildMatcher();
    let matchCount = 0;
    const htmlParts = [];

    rawLines.forEach((line, idx) => {
      const { html, matched } = highlightLine(line, matcher);
      if (matcher && !matched) {
        return;
      }
      if (matcher) {
        matchCount++;
      }
      const absoluteLine = startLine + idx;
      htmlParts.push(
        '<span class="line">' +
          '<span class="lineNum" data-line="' +
          absoluteLine +
          '" title="Open line ' +
          absoluteLine +
          ' in editor">' +
          absoluteLine +
          '</span>' +
          '<span class="lineText">' +
          html +
          '</span>' +
          '</span>'
      );
    });

    // Each .line span is display:block, which already forces a line break;
    // joining with '\n' here would add a second one since #content is a <pre>
    // that preserves whitespace, producing a blank line after every entry.
    content.innerHTML = htmlParts.join('');

    const total = rawLines.length;
    statusText.textContent = matcher
      ? `${matchCount} / ${total} lines matching \u00b7 buffer limit ${lineLimitInput.value}`
      : `${total} lines \u00b7 buffer limit ${lineLimitInput.value}`;

    if (following) {
      scrollToBottom();
    }
  }

  function scrollToBottom() {
    scrollArea.scrollTop = scrollArea.scrollHeight;
    jumpBar.classList.add('hidden');
  }

  scrollArea.addEventListener('scroll', () => {
    const atBottom = scrollArea.scrollTop + scrollArea.clientHeight >= scrollArea.scrollHeight - SCROLL_EPS;
    following = atBottom;
    jumpBar.classList.toggle('hidden', atBottom);
  });

  jumpBtn.addEventListener('click', () => {
    following = true;
    scrollToBottom();
  });

  filterInput.addEventListener('input', () => {
    render();
    persistState();
  });
  regexToggle.addEventListener('change', () => {
    render();
    persistState();
  });
  caseToggle.addEventListener('change', () => {
    render();
    persistState();
  });

  filterClearBtn.addEventListener('click', () => {
    filterInput.value = '';
    filterInput.focus();
    render();
    persistState();
  });

  lineLimitInput.addEventListener('change', () => {
    vscode.postMessage({ type: 'setLineLimit', value: Number(lineLimitInput.value) });
    persistState();
  });

  clearBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'clear' });
  });

  // Event delegation: gutter numbers are re-created on every render, so a
  // single listener on the (stable) content container handles all of them.
  content.addEventListener('click', (e) => {
    const target = e.target.closest('.lineNum');
    if (!target) {
      return;
    }
    const lineNumber = Number(target.getAttribute('data-line'));
    if (Number.isFinite(lineNumber) && lineNumber > 0) {
      vscode.postMessage({ type: 'gotoLine', line: lineNumber });
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        currentFilePath = msg.filePath;
        rawLines = msg.lines;
        startLine = typeof msg.startLine === 'number' ? msg.startLine : 1;
        lineLimitInput.value = msg.lineLimit;
        following = true;
        render();
        persistState();
        // The extension host always starts a fresh session at the default line
        // limit (custom editors don't hand back previously persisted state the
        // way a plain webview serializer would). If we remember a different
        // limit from before a reload, ask it to re-read the tail with that
        // limit instead.
        if (
          typeof previousState.lineLimit === 'number' &&
          previousState.lineLimit > 0 &&
          previousState.lineLimit !== msg.lineLimit
        ) {
          lineLimitInput.value = previousState.lineLimit;
          vscode.postMessage({ type: 'setLineLimit', value: previousState.lineLimit });
        }
        break;
      case 'update':
        applyIncomingLines(msg.lines, msg.startLine, msg.force);
        break;
      case 'error':
        statusText.textContent = 'Error: ' + msg.message;
        break;
      case 'info':
        statusText.textContent = msg.message;
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
