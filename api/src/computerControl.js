import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);


function missingToolError(tool, err) {
  if (err.code === 'ENOENT') {
    return new Error(`${tool} not installed — install it via your distro's package manager (e.g. "xdotool grim" on Arch/pacman).`);
  }
  return err;
}

async function xdotool(args) {
  try {
    const { stdout } = await execFileAsync('xdotool', args, { timeout: 10000 });
    return stdout.trim();
  } catch (err) {
    throw missingToolError('xdotool', err);
  }
}

function pngDimensions(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export async function computerScreenshot() {
  try {
    const { stdout } = await execFileAsync('grim', ['-t', 'png', '-'], {
      timeout: 10000,
      encoding: 'buffer',
      maxBuffer: 1024 * 1024 * 50,
    });
    return { buffer: stdout, ...pngDimensions(stdout) };
  } catch (err) {
    throw missingToolError('grim', err);
  }
}

export async function computerMoveMouse({ x, y }) {
  if (x === undefined || y === undefined) throw new Error('x and y are required.');
  await xdotool(['mousemove', '--sync', String(Math.round(x)), String(Math.round(y))]);
}

export async function computerClick({ x, y, button }) {
  if (x === undefined || y === undefined) throw new Error('x and y are required.');
  const code = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
  await xdotool(['mousemove', '--sync', String(Math.round(x)), String(Math.round(y))]);
  await xdotool(['click', code]);
}

export async function computerType({ text }) {
  if (text === undefined) throw new Error('text is required.');
  await xdotool(['type', '--', text]);
}

export async function computerKey({ key }) {
  if (!key) throw new Error('key is required.');
  await xdotool(['key', key]);
}

export async function computerScroll({ direction, amount }) {
  const code = direction === 'up' ? '4' : '5';
  await xdotool(['click', '--repeat', String(amount || 3), code]);
}
