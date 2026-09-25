import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {MAX_FILES, MAX_PER_FILE_BYTES, checkFiles, contentMatchesExtension, extractAttachments} from './uploads.ts';

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

describe('file content checks (tester 2)', () => {
  it('refuses an empty file', () => {
    assert.deepEqual(checkFiles([f('photo.jpg', 0, 'image/jpeg')]), {problem: 'empty', file: 'photo.jpg'});
  });

  it('refuses a program renamed to .jpg and accepts real images and video', async () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    const mp4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    assert.equal(contentMatchesExtension('x.jpg', exe), false);
    assert.equal(contentMatchesExtension('x.jpg', jpg), true);
    assert.equal(contentMatchesExtension('flight.mp4', mp4), true);
    assert.equal(contentMatchesExtension('LOG00001.bbl', exe), true, 'logs have no signature');
    const form = new FormData();
    form.append('files', new File([exe], 'holiday.jpg', {type: 'image/jpeg'}));
    assert.deepEqual(await extractAttachments(form), {ok: false, problem: 'type', file: 'holiday.jpg'});
  });

  it('treats an untouched file input as no file', async () => {
    const form = new FormData();
    form.append('files', new File([], '', {type: 'application/octet-stream'}));
    assert.deepEqual(await extractAttachments(form), {ok: true, files: []});
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
