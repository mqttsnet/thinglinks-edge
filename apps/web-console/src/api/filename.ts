/**
 * 解析 `content-disposition` 里的文件名。
 *
 * 单独成文件是为了**能被单测直接 import**：`client.ts` 在模块顶层读 `window`，
 * 在 node 的测试环境里一导入就抛。
 */

/**
 * 取文件名，`filename*` 优先于 `filename`。
 *
 * HTTP 头是 ByteString，装不下中文，所以后端对非 ASCII 的名字给两份：
 * `filename` 是把中文换成下划线的兜底名，`filename*` 才是 RFC 5987
 * 编码过的原名。只认前者的话，「产线采集基线」会下成 `flows_______.json`
 * —— 存盘、找回、发给同事全靠这个名字，一串下划线等于把它丢了。
 */
export function filenameFrom(disposition: string, fallback: string): string {
  const ext = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(disposition)?.[1];
  if (ext) {
    try {
      const decoded = decodeURIComponent(ext);
      // 解出空串时要退回兜底名，否则 a.download='' 会让浏览器
      // 拿 URL 末段当文件名 —— 那是个 uuid，比兜底名还糟
      if (decoded !== '') return decoded;
    } catch { /* 编码坏了就退回下面的 filename */ }
  }
  return /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallback;
}
