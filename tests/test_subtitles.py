"""Subtitle tracks for the player: sidecar discovery, SRT -> VTT, embedded
tracks through ffmpeg (skipped where it isn't installed), and the two route
surfaces that hand them out."""
import shutil
import subprocess
import pytest

from backend import subtitles

HAS_FFMPEG = shutil.which('ffmpeg') is not None and shutil.which('ffprobe') is not None

SRT = (
    "1\r\n00:00:01,000 --> 00:00:02,500\r\nHello there\r\n\r\n"
    "2\r\n00:00:03,20 --> 00:00:04,000\r\n{\\an8}Up top\r\nsecond line\r\n"
)


@pytest.fixture
def movie(tmp_path):
    video = tmp_path / 'Movie.mkv'
    video.write_bytes(b'\x1aE\xdf\xa3' + b'\0' * 64)  # not a real MKV; ffprobe just finds nothing
    (tmp_path / 'Movie.srt').write_text(SRT, encoding='utf-8')
    (tmp_path / 'Movie.en.vtt').write_text('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n')
    (tmp_path / 'Movie.de.forced.srt').write_text(SRT)
    (tmp_path / 'Other.srt').write_text(SRT)         # someone else's
    (tmp_path / 'Movie.nfo').write_text('x')         # not a subtitle
    return video


# --- listing --------------------------------------------------------------

def test_sidecars_match_the_stem_and_name_their_language(movie, monkeypatch):
    monkeypatch.setattr(subtitles, '_probe_streams', lambda v: [])
    tracks = subtitles.list_tracks(movie)
    ids = [t['id'] for t in tracks]
    assert ids == ['f:Movie.de.forced.srt', 'f:Movie.en.vtt', 'f:Movie.srt']
    by_id = {t['id']: t for t in tracks}
    assert by_id['f:Movie.en.vtt']['label'] == 'English' and by_id['f:Movie.en.vtt']['lang'] == 'en'
    assert by_id['f:Movie.de.forced.srt']['forced'] is True
    assert by_id['f:Movie.srt']['label'] == 'SRT file'
    assert all(t['kind'] == 'sidecar' for t in tracks)


def test_embedded_tracks_skip_bitmap_codecs(movie, monkeypatch):
    streams = [
        {'codec_name': 'subrip', 'tags': {'language': 'eng', 'title': 'English SDH'},
         'disposition': {'default': 1, 'forced': 0}},
        {'codec_name': 'hdmv_pgs_subtitle', 'tags': {'language': 'eng'}, 'disposition': {}},
        {'codec_name': 'ass', 'tags': {'language': 'jpn'}, 'disposition': {'forced': 1}},
    ]
    monkeypatch.setattr(subtitles, '_probe_streams', lambda v: streams)
    tracks = [t for t in subtitles.list_tracks(movie) if t['kind'] == 'embedded']
    assert [t['id'] for t in tracks] == ['s:0', 's:2']
    assert tracks[0]['label'] == 'English SDH' and tracks[0]['default'] is True
    # The id counts every subtitle stream, bitmap ones included, because
    # ffmpeg's `0:s:N` does - skipping s:1 here is what makes `-map` land.
    assert tracks[1]['label'] == 'Japanese (forced)' and tracks[1]['lang'] == 'jpn'


def test_listing_a_missing_video_is_a_404(tmp_path):
    with pytest.raises(subtitles.SubtitleError) as e:
        subtitles.list_tracks(tmp_path / 'nope.mkv')
    assert e.value.status == 404


# --- rendering ------------------------------------------------------------

def test_srt_becomes_vtt_with_dotted_timings():
    out = subtitles.srt_to_vtt(SRT)
    assert out.startswith('WEBVTT\n\n')
    assert '00:00:01.000 --> 00:00:02.500' in out
    assert '00:00:03.200 --> 00:00:04.000' in out   # short millis padded
    assert '{\\an8}' not in out and 'Up top\nsecond line' in out
    assert '\r' not in out


def test_render_sidecar_srt_and_vtt(movie):
    assert subtitles.render_vtt(movie, 'f:Movie.srt').startswith('WEBVTT')
    assert subtitles.render_vtt(movie, 'f:Movie.en.vtt') == 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n'


def test_render_refuses_ids_that_leave_the_video_folder(movie, tmp_path):
    (tmp_path.parent / 'Movie.srt').write_text(SRT)
    for bad in ('f:../Movie.srt', 'f:/etc/passwd', 'f:Other.srt', 'f:Movie.nfo', 'x:1', '', 's:abc'):
        with pytest.raises(subtitles.SubtitleError) as e:
            subtitles.render_vtt(movie, bad)
        assert e.value.status in (400, 404), bad


@pytest.mark.skipif(not HAS_FFMPEG, reason='ffmpeg not installed')
def test_embedded_track_is_extracted_and_cached(tmp_path, monkeypatch):
    # Build a tiny MKV with one subtitle stream, the way a real file carries it.
    srt = tmp_path / 'in.srt'
    srt.write_text(SRT)
    video = tmp_path / 'Clip.mkv'
    subprocess.run([subtitles.FFMPEG_PATH, '-v', 'error', '-y',
                    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=5', '-i', str(srt),
                    '-c:v', 'libx264', '-c:s', 'srt', '-metadata:s:s:0', 'language=eng',
                    str(video)], check=True, timeout=60)
    monkeypatch.setattr(subtitles, 'CACHE_DIR', tmp_path / 'cache')

    tracks = subtitles.list_tracks(video)
    assert [t['id'] for t in tracks] == ['s:0'] and tracks[0]['lang'] == 'eng'

    out = subtitles.render_vtt(video, 's:0')
    assert out.startswith('WEBVTT') and 'Hello there' in out
    cached = list((tmp_path / 'cache').glob('*.vtt'))
    assert len(cached) == 1
    # Second render is served from the cache: break ffmpeg and ask again.
    monkeypatch.setattr(subtitles, 'FFMPEG_PATH', '/nonexistent/ffmpeg')
    assert subtitles.render_vtt(video, 's:0') == out


# --- routes ---------------------------------------------------------------

def _media(client, auth):
    return client.get('/api/auth/media-token', headers=auth).get_json()['media_token']


def test_explorer_routes_list_and_serve_a_sidecar(client, db, auth, movie, monkeypatch):
    monkeypatch.setattr(subtitles, '_probe_streams', lambda v: [])
    res = client.post('/api/files/subtitles', json={'path': str(movie)}, headers=auth)
    assert res.status_code == 200
    assert 'f:Movie.srt' in [t['id'] for t in res.get_json()['tracks']]

    token = _media(client, auth)
    res = client.get(f'/api/files/subtitle?path={movie}&track=f:Movie.srt&token={token}')
    assert res.status_code == 200
    assert res.mimetype == 'text/vtt'
    assert res.get_data(as_text=True).startswith('WEBVTT')

    # A traversal is a bad id (400); a well-formed id naming nothing is a 404.
    res = client.get(f'/api/files/subtitle?path={movie}&track=f:../x.srt&token={token}')
    assert res.status_code == 400
    res = client.get(f'/api/files/subtitle?path={movie}&track=f:Movie.xx.srt&token={token}')
    assert res.status_code == 404


def test_explorer_subtitles_need_the_api_token_and_refuse_the_vps(client, db, auth, movie):
    assert client.post('/api/files/subtitles', json={'path': str(movie)}).status_code == 401
    res = client.post('/api/files/subtitles', json={'path': 'vps:/home/x/Movie.mkv'}, headers=auth)
    assert res.status_code == 400


def test_download_routes_find_the_file_through_the_record(client, db, auth, movie, monkeypatch):
    monkeypatch.setattr(subtitles, '_probe_streams', lambda v: [])
    from backend.web_app.routes import media
    monkeypatch.setattr(media, 'candidate_file_paths', lambda d, f: [movie])
    row = db.add_download(file='Movie.mkv', status='done', progress=100,
                          downloaded_from='telegram', message_id='sub-1')
    did = row['id'] if isinstance(row, dict) else row.id

    res = client.get(f'/api/video/subtitles/{did}', headers=auth)
    assert res.status_code == 200
    assert [t['id'] for t in res.get_json()['tracks']][-1] == 'f:Movie.srt'

    token = _media(client, auth)
    res = client.get(f'/api/video/subtitle/{did}?track=f:Movie.en.vtt&token={token}')
    assert res.status_code == 200 and 'Hi' in res.get_data(as_text=True)

    assert client.get(f'/api/video/subtitles/99999', headers=auth).status_code == 404
