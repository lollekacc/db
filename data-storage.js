const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const getDataDirectory = () => path.resolve(
  process.env.DEALETT_DATA_DIR || path.join(__dirname, 'data')
);

const getDataFilePath = (...segments) => path.join(getDataDirectory(), ...segments);

const writeJsonAtomic = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
};

module.exports = {
  getDataFilePath,
  writeJsonAtomic,
};
