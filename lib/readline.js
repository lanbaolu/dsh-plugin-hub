/**
 * @lanbaolu/dsh-plugin-hub — 轻量行分帧器（处理 stream chunk 边界，零依赖）。
 * 替代 node:readline（其逐行回调/错误语义在本场景更繁琐）。
 */
export class ReadlineInterface {
  constructor(stream) {
    this._buffer = ''
    this._handlers = []
    if (stream) stream.on('data', (chunk) => this._push(chunk))
  }

  onLine(fn) {
    this._handlers.push(fn)
    return () => {
      const i = this._handlers.indexOf(fn)
      if (i >= 0) this._handlers.splice(i, 1)
    }
  }

  _push(chunk) {
    this._buffer += chunk.toString('utf8')
    let idx
    while ((idx = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, idx).replace(/\r$/, '')
      this._buffer = this._buffer.slice(idx + 1)
      for (const handler of [...this._handlers]) handler(line)
    }
  }
}

export default ReadlineInterface
