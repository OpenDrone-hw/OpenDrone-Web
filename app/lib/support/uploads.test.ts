import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {MAX_FILES, MAX_PER_FILE_BYTES, checkFiles, extractAttachments} from './uploads.ts';

const MB = 1024 * 1024;
const f = (name: string, size: number, type = '') => ({name, size, type});

describe('checkFiles', () => {
  it('accepts photos, video, logs and firmware', () => {
    assert.equal(
      checkFiles([f('esc.jpg', MB, 'image/jpeg'), f('flight.mp4', 7 * MB, 'video/mp4'), f('LOG00012.bbl', 3 * MB), f('fw.hex', 200_000)]),
      null,
    );
  });

  it('refuses more than five files', () => {
    assert.deepEqual(checkFiles(Array.from({length: MAX_FILES + 1}, (_, i) => f(`${i}.png`, 10, 'image/png'))), {problem: 'too_many'});
  });

  it('refuses a file over 8 MB and a total over 24 MB', () => {
    assert.deepEqual(checkFiles([f('big.mp4', MAX_PER_FILE_BYTES + 1, 'video/mp4')]), {problem: 'too_big', file: 'big.mp4'});
    assert.deepEqual(
      checkFiles([f('a.mp4', 8 * MB, 'video/mp4'), f('b.mp4', 8 * MB, 'video/mp4'), f('c.mp4', 8 * MB, 'video/mp4'), f('d.png', 10, 'image/png')]),
      {problem: 'total_too_big'},
    );
  });

  it('refuses SVG, HTML and unknown extensions even with an allowed type', () => {
    assert.equal(checkFiles([f('x.svg', 10, 'image/svg+xml')])?.problem, 'type');
    assert.equal(checkFiles([f('x.html', 10, 'text/html')])?.problem, 'type');
    assert.equal(checkFiles([f('x.exe', 10, 'application/octet-stream')])?.problem, 'type');
    assert.equal(checkFiles([f('photo.png.exe', 10, 'image/png')])?.problem, 'type');
    assert.equal(checkFiles([f('noext', 10, 'image/png')])?.problem, 'type');
  });
});

describe('extractAttachments', () => {
  it('reads valid files and skips empty inputs', async () => {
    const form = new FormData();
    form.append('files', new File([new Uint8Array([1, 2, 3])], 'log.txt', {type: 'text/plain'}));
    form.append('files', new File([], '', {type: 'application/octet-stream'}));
    const r = await extractAttachments(form);
    assert.ok(r.ok);
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0]!.name, 'log.txt');
  });

  it('reports the problem instead of reading', async () => {
    const form = new FormData();
    form.append('files', new File(['<svg/>'], 'logo.svg', {type: 'image/svg+xml'}));
    const r = await extractAttachments(form);
    assert.deepEqual(r, {ok: false, problem: 'type', file: 'logo.svg'});
  });
});
