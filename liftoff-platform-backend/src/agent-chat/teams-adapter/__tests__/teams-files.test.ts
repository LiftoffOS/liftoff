import { findTeamsAudio } from '../teams-files';

describe('findTeamsAudio', () => {
  it('finds an inline audio attachment', () => {
    expect(
      findTeamsAudio([{ contentType: 'audio/mp4', contentUrl: 'https://example.com/memo.mp4' }]),
    ).toEqual({ url: 'https://example.com/memo.mp4', mimeType: 'audio/mp4' });
  });

  it('finds a file the user uploaded, whose real link is nested', () => {
    // Teams wraps an uploaded file rather than describing it inline, and the
    // wrapper's contentType says nothing about the audio inside it.
    expect(
      findTeamsAudio([
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: 'voice-note.m4a',
          content: { downloadUrl: 'https://example.com/dl', fileType: 'm4a' },
        },
      ]),
    ).toEqual({ url: 'https://example.com/dl', mimeType: 'audio/mp4' });
  });

  it('ignores attachments that are not audio', () => {
    expect(findTeamsAudio([{ contentType: 'image/png', contentUrl: 'https://x/y.png' }])).toBeNull();
    expect(
      findTeamsAudio([
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: 'report.pdf',
          content: { downloadUrl: 'https://example.com/dl', fileType: 'pdf' },
        },
      ]),
    ).toBeNull();
  });

  it('ignores a wrapper with no link, rather than returning a broken ref', () => {
    expect(
      findTeamsAudio([
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: 'voice-note.m4a',
          content: {},
        },
      ]),
    ).toBeNull();
  });

  it('survives activities with no attachments at all', () => {
    expect(findTeamsAudio(undefined)).toBeNull();
    expect(findTeamsAudio([])).toBeNull();
    expect(findTeamsAudio('not an array')).toBeNull();
  });
});
