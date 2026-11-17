import { findAudioFile } from '../slack-files';

describe('findAudioFile', () => {
  it('finds a memo by its audio mimetype', () => {
    const file = { id: 'F1', mimetype: 'audio/mp4' };
    expect(findAudioFile([file])).toBe(file);
  });

  it('finds a memo Slack labelled as video', () => {
    // A voice memo is an MP4 container, and Slack serves it as video/mp4 even
    // though there is no video in it. Requiring audio/* rejected real memos —
    // the subtype is the reliable signal.
    const file = { id: 'F2', mimetype: 'video/mp4', subtype: 'slack_audio' };
    expect(findAudioFile([file])).toBe(file);
  });

  it('ignores an actual video, which is not a voice memo', () => {
    expect(findAudioFile([{ id: 'F3', mimetype: 'video/mp4' }])).toBeNull();
  });

  it('ignores other attachments and malformed input', () => {
    expect(findAudioFile([{ id: 'F4', mimetype: 'image/png' }])).toBeNull();
    expect(findAudioFile(undefined)).toBeNull();
    expect(findAudioFile('nope')).toBeNull();
  });
});
