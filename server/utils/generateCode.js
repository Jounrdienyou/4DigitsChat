async function generateUniqueCode(Model) {
  let code;
  let exists = true;
  while (exists) {
    code = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit string
    exists = await Model.exists({ code });
  }
  return code;
}

module.exports = generateUniqueCode; 