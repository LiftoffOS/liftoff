import { promises as fs, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { strReplaceEditor } from '../../file/editor';

// We point the editor at a temp dir but the validator forces /workspace.
// We rebind WORKSPACE_ROOT by symlinking — the tests pass paths under
// /workspace via the validator. In CI the container has /workspace; in jest
// we just stub the validator.
jest.mock('@liftoffos/sandbox-validators', () => ({
  validateWorkspacePath: (p?: string) => p ?? '/workspace',
}));

describe('strReplaceEditor', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'editor-test-'));
  });

  it('create writes a new file then refuses overwrite', async () => {
    const path = join(dir, 'a.txt');
    const res = await strReplaceEditor({ command: 'create', path, file_text: 'hello\nworld' });
    expect(res.result).toContain('created');
    await expect(strReplaceEditor({ command: 'create', path, file_text: 'x' })).rejects.toThrow(/already exists/);
    expect(await fs.readFile(path, 'utf-8')).toBe('hello\nworld');
  });

  it('view returns numbered lines', async () => {
    const path = join(dir, 'b.txt');
    await fs.writeFile(path, 'one\ntwo\nthree');
    const res = await strReplaceEditor({ command: 'view', path });
    expect(res.result).toMatch(/^\s+1\tone/);
    expect(res.result).toMatch(/3\tthree/);
  });

  it('str_replace rejects ambiguous old_str', async () => {
    const path = join(dir, 'c.txt');
    await fs.writeFile(path, 'foo bar foo');
    await expect(strReplaceEditor({ command: 'str_replace', path, old_str: 'foo', new_str: 'baz' })).rejects.toThrow(/not unique/);
  });

  it('str_replace replaces the unique occurrence', async () => {
    const path = join(dir, 'd.txt');
    await fs.writeFile(path, 'aaa bbb ccc');
    await strReplaceEditor({ command: 'str_replace', path, old_str: 'bbb', new_str: 'BBB' });
    expect(await fs.readFile(path, 'utf-8')).toBe('aaa BBB ccc');
  });

  it('insert puts new_str after insert_line', async () => {
    const path = join(dir, 'e.txt');
    await fs.writeFile(path, 'line1\nline2\nline3');
    await strReplaceEditor({ command: 'insert', path, insert_line: 1, new_str: 'inserted' });
    expect((await fs.readFile(path, 'utf-8')).split('\n')).toEqual(['line1', 'inserted', 'line2', 'line3']);
  });

  it('undo_edit reverts the last edit', async () => {
    const path = join(dir, 'f.txt');
    await fs.writeFile(path, 'original');
    await strReplaceEditor({ command: 'str_replace', path, old_str: 'original', new_str: 'changed' });
    await strReplaceEditor({ command: 'undo_edit', path });
    expect(await fs.readFile(path, 'utf-8')).toBe('original');
  });

  it('undo_edit on never-edited file fails with no_history', async () => {
    const path = join(dir, 'g.txt');
    await fs.writeFile(path, 'untouched');
    await expect(strReplaceEditor({ command: 'undo_edit', path })).rejects.toThrow(/no history/i);
  });
});
