const buildChatInstructions = (source) => {
  const sections = String(source).replace(/\r\n?/g, '\n').split(/(?=^## )/m);
  const analysisInstructions = 'Task: analyze_customer_message. Return only the required structured analysis.\n\n' + sections.filter(section =>
    /^(?:# Dealett|## (?:Role|Source authority|Truthfulness and scope|Message analysis)\n)/.test(section)
  ).join('\n');
  const replyInstructions = 'Task: generate_customer_reply. Write naturally within all supplied constraints and return only the required structured output.\n\n' + sections.filter(section =>
    !/^## (?:Task modes|Message analysis)\n/.test(section)
  ).join('\n');
  const ordinaryReplyInstructions = replyInstructions.split(/(?=^## )/m).filter(section =>
    !/^## (?:Recommendation calculation|Decision support and tradeoffs|Secondary offer)\n/.test(section)
  ).join('\n');
  return { analysisInstructions, replyInstructions, ordinaryReplyInstructions };
};

module.exports = { buildChatInstructions };
