import { generatePostman } from './postman.js';
await generatePostman(process.argv.includes('--check'));
process.stdout.write(
  'Postman collection and local environment are up to date\n',
);
