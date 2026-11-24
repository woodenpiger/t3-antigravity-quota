export const MARK_START = '<!-- t3-antigravity-quota:start -->';
export const MARK_END = '<!-- t3-antigravity-quota:end -->';

export function injectionBlock(port, buildTag) {
  const tag = buildTag || '2';
  const lines = [
    MARK_START,
    '    <link rel="stylesheet" href="/assets/antigravity-quota.css?v=' + tag + '" />',
  ];
  if (port) {
    lines.push('    <script>window.__T3_AG_QUOTA_PORT__=' + Number(port) + ';</script>');
  }
  lines.push(
    '    <script defer src="/assets/antigravity-quota.js?v=' + tag + '"></script>',
    '    ' + MARK_END,
  );
  return lines.join('\n');
}

export function injectHtml(html, port, buildTag) {
  const block = injectionBlock(port, buildTag);
  const start = html.indexOf(MARK_START);
  const end = html.indexOf(MARK_END);
  if (start >= 0 && end > start) {
    return html.slice(0, start) + block + html.slice(end + MARK_END.length);
  }
  const headEnd = html.lastIndexOf('</head>');
  if (headEnd < 0) throw new Error('index.html has no </head>');
  return html.slice(0, headEnd) + block + '\n  ' + html.slice(headEnd);
}

export function stripHtml(html) {
  const start = html.indexOf(MARK_START);
  const end = html.indexOf(MARK_END);
  if (start < 0 || end <= start) return html;
  return html.slice(0, start) + html.slice(end + MARK_END.length);
}
