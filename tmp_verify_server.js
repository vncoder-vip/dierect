const fs = require('fs');
const path = require('path');
const { getConfiguredSanityStorages, listCommentsFromStorageManager } = require('./server');

async function main() {
  const output = {
    storages: getConfiguredSanityStorages(),
    commentCount: null,
    comments: null,
    error: null
  };

  try {
    output.comments = await listCommentsFromStorageManager();
    output.commentCount = output.comments.length;
  } catch (error) {
    output.error = { message: error.message, statusCode: error.statusCode, details: error.details };
  }

  fs.writeFileSync(path.join(__dirname, 'tmp_verify_server_output.json'), JSON.stringify(output, null, 2));
}

main();
