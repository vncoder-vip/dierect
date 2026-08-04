const { listCommentsFromStorageManager } = require('./server');
listCommentsFromStorageManager()
  .then((comments) => {
    console.log('COMMENTS', JSON.stringify(comments, null, 2));
  })
  .catch((error) => {
    console.error('ERROR', error);
    process.exit(1);
  });
