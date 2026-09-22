const readEvents = async (body, onEvent) => {
  if (!body) throw new Error('Missing response stream');
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = () => {
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data && data !== '[DONE]') onEvent(JSON.parse(data));
    }
    if (buffer.length > 2_000_000) throw new Error('Response stream too large');
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    consume();
  }
  buffer += decoder.decode();
  consume();
  if (buffer.trim()) throw new Error('Interrupted response stream');
};

const replyPrefix = (json) => {
  const start = /^\s*\{\s*"reply"\s*:\s*"/.exec(json);
  if (!start) return '';
  let end = start[0].length;
  for (let i = end; i < json.length; i += 1) {
    if (json[i] === '"') break;
    if (json[i] === '\\') {
      if (i + 1 >= json.length) break;
      if (json[i + 1] === 'u') {
        if (i + 5 >= json.length) break;
        i += 5;
      } else i += 1;
    }
    end = i + 1;
  }
  const value = JSON.parse('"' + json.slice(start[0].length, end) + '"');
  return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
};

module.exports = { readEvents, replyPrefix };
