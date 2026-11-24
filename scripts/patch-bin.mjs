export const BIN_MARK_START = '/* t3-antigravity-quota:hook:start */';
export const BIN_MARK_END = '/* t3-antigravity-quota:hook:end */';

const HOOK_SNIPPET = [
  BIN_MARK_START,
  'if (!["__service-launcher","__document-text","__managed-chatgpt-token","acp-mcp-bridge","acp-mcp-call","__speech-worker"].includes(process.argv[2])) {',
  '  await import("./t3-ag-quota/hook.mjs");',
  '}',
  BIN_MARK_END,
].join('\n');

export function injectBinMjs(source) {
  const stripped = stripBinMjs(source);
  const anchor = 'const { runCliCommand } = await import("./binCli-';
  const anchorFallback = 'const { runCliCommand } = await loadCliMain();';
  let idx = stripped.indexOf(anchorFallback);
  if (idx < 0) idx = stripped.indexOf(anchor);
  if (idx < 0) {
    throw new Error('bin.mjs entrypoint anchor not found');
  }
  return stripped.slice(0, idx) + HOOK_SNIPPET + '\n' + stripped.slice(idx);
}

export function stripBinMjs(source) {
  const start = source.indexOf(BIN_MARK_START);
  const end = source.indexOf(BIN_MARK_END);
  if (start < 0 || end <= start) return source;
  const after = end + BIN_MARK_END.length;
  const trimNl = source[after] === '\n' ? 1 : 0;
  return source.slice(0, start) + source.slice(after + trimNl);
}
