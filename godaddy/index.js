const fs = require('fs');
const path = require('path');

const reportPath = path.join(__dirname, 'report.html');
const reportExists = fs.existsSync(reportPath);

console.log(`Domain report runner ready: ${reportExists ? 'report found' : 'report missing'}`);
