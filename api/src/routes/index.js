import { readdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default async (app) => {
  const files = readdirSync(__dirname).filter(
    (file) => file !== 'index.js' && file.endsWith('.js')
  );

  for (const file of files) {
    const { default: register } = await import(
      pathToFileURL(resolve(__dirname, file)).href
    );
    register(app);
  }
};
