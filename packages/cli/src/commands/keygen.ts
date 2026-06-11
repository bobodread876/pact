import { importIdentity } from '../core/src/keystore';
import { prompt } from 'inquirer';

const keygenCommand = {
  command: 'keygen',
  describe: 'Generate or import an identity',
  builder: (yargs) => {
    yargs.option('import', {
      type: 'boolean',
      describe: 'Import an existing identity',
    });
  },
  handler: async (argv) => {
    if (argv.import) {
      const secret = await prompt({
        type: 'password',
        name: 'secret',
        message: 'Enter your secret:',
      });
      try {
        const publicIdentity = importIdentity(secret.secret);
        console.log(publicIdentity);
      } catch (error) {
        console.error(error.message);
      }
    } else {
      // Generate a new identity
      const publicIdentity = generateIdentity();
      console.log(publicIdentity);
    }
  },
};

export default keygenCommand;