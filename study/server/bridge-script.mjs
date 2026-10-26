// The script is distributed from the running instance, so custom ports cannot
// silently keep talking to a different local study service.
export function localRequestOrigin(hostHeader, port) {
  const match = /^(127\.0\.0\.1|localhost)(?::(\d+))?$/.exec(hostHeader ?? '');
  if (!match || Number(match[2] ?? 80) !== port) return null;
  return `http://${match[1]}${port === 80 ? '' : `:${port}`}`;
}

export function renderBridgeScript(source, origin) {
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)) throw new Error('无效的本机脚本来源。');
  const marker = "const LOCAL_ORIGIN = 'http://127.0.0.1:18103'; // yankao-service-origin";
  if (source.split(marker).length !== 2) throw new Error('浏览器助手缺少唯一的服务来源标记。');
  const scriptUrl = `${origin}/bridge/Study-Bridge.user.js`;
  let matches = 0;
  let urls = 0;
  let namespaces = 0;
  const rendered = source.replace(marker, `const LOCAL_ORIGIN = '${origin}'; // yankao-service-origin`)
    .replace(/^(\/\/[ \t]*@namespace[ \t]+)https:\/\/yankao\.local\/study[ \t]*\r?$/gm,
      (_, prefix) => { namespaces++; return `${prefix}${origin}/study/bridge`; })
    .replace(/^(\/\/[ \t]*@match[ \t]+)http:\/\/(?:127\.0\.0\.1|localhost):18103\/\*[ \t]*\r?$/gm, (_, prefix) => { matches++; return `${prefix}${origin}/*`; })
    .replace(/^(\/\/[ \t]*@(updateURL|downloadURL)[ \t]+)http:\/\/127\.0\.0\.1:18103\/bridge\/Study-Bridge\.user\.js[ \t]*\r?$/gm,
      (_, prefix) => { urls++; return `${prefix}${scriptUrl}`; });
  if (matches !== 2 || urls !== 2 || namespaces !== 1) throw new Error('浏览器助手本机安装元数据不完整。');
  // Both default aliases become this exact origin; duplicate @match has no value.
  return rendered.replace(/(^\/\/\s*@match\s+[^\r\n]+\r?\n)\1/m, '$1');
}
