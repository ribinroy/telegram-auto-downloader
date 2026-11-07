"""The VR headset feed: projection guessing, the key, and the two JSON
shapes (HereSphere's and DeoVR's) served to the apps."""
import pytest

from backend import vr


# --- projection -----------------------------------------------------------

@pytest.mark.parametrize('name,expected', [
    ('Holiday 2024.mp4', ('flat', None)),
    ('square-clip.mp4', ('flat', None)),
    ('Scene_180_sbs.mp4', ('180-sbs', None)),
    ('Scene_LR_180.mp4', ('180-sbs', None)),
    ('Scene_180_TB.mp4', ('180-tb', None)),
    ('Scene_180_mono.mp4', ('180-mono', None)),
    ('Tour_360.mp4', ('360-mono', None)),
    ('Tour_360_TB.mp4', ('360-tb', None)),
    ('Scene_MKX200.mp4', ('180-sbs', 'MKX200')),
    ('Scene_MKX220_LR.mkv', ('180-sbs', 'MKX220')),
    ('Scene_VRCA220.mp4', ('180-sbs', 'VRCA220')),
    ('Scene_RF52_TB.mp4', ('180-tb', 'RF52')),
    ('Scene_FISHEYE190_LR.mp4', ('180-sbs', 'FISHEYE190')),
    ('Scene_fisheye.mp4', ('180-sbs', 'FISHEYE')),
    ('Album180x.mp4', ('flat', None)),
    ('/Movies/Some.Film.2023.1080p.mkv', ('flat', None)),
])
def test_detect_projection_matches_the_web_player(name, expected):
    projection, lens, _ = vr.detect_projection(name)
    assert (projection, lens) == expected


def test_aspect_settles_the_layout_only_when_the_name_says_vr():
    assert vr.detect_projection('Scene_180.mp4', 2.0)[0] == '180-sbs'
    assert vr.detect_projection('Scene_180.mp4', 1.0)[0] == '180-mono'
    assert vr.detect_projection('Scene_VR.mp4', 4.0)[0] == '360-sbs'
    assert vr.detect_projection('Tour_360.mp4', 1.0)[0] == '360-tb'
    assert vr.detect_projection('wide.mkv', 2.0)[0] == 'flat'


def test_the_users_pick_wins_over_the_guess():
    d = {'file': 'Scene_180_sbs.mp4', 'vr_projection': '360-tb'}
    assert vr.projection_for(d)[0] == '360-tb'
    d['vr_projection'] = 'bogus'
    assert vr.projection_for(d)[0] == '180-sbs'
    d['vr_projection'] = 'flat'
    assert vr.projection_for({**d, 'file': 'Scene_MKX200.mp4'}) == ('flat', None, 200.0)


def test_geometry_mapping():
    assert vr.heresphere_geometry('flat', None, 180) == {
        'projection': 'perspective', 'stereo': 'mono', 'fov': 180.0, 'lens': 'Linear'}
    assert vr.heresphere_geometry('180-sbs', None, 180) == {
        'projection': 'equirectangular', 'stereo': 'sbs', 'fov': 180.0, 'lens': 'Linear'}
    assert vr.heresphere_geometry('360-tb', None, 180)['projection'] == 'equirectangular360'
    assert vr.heresphere_geometry('180-sbs', 'MKX200', 200.0) == {
        'projection': 'fisheye', 'stereo': 'sbs', 'fov': 200.0, 'lens': 'MKX200'}
    assert vr.heresphere_geometry('180-sbs', 'RF52', 190.0)['lens'] == 'Linear'

    assert vr.deovr_geometry('flat', None, 180) == {'screenType': 'flat', 'stereoMode': 'off', 'is3d': False}
    assert vr.deovr_geometry('180-sbs', None, 180) == {'screenType': 'dome', 'stereoMode': 'sbs', 'is3d': True}
    assert vr.deovr_geometry('360-mono', None, 180) == {'screenType': 'sphere', 'stereoMode': 'off', 'is3d': False}
    assert vr.deovr_geometry('180-tb', 'MKX200', 200.0)['screenType'] == 'mkx200'
    assert vr.deovr_geometry('180-sbs', 'RF52', 190.0)['screenType'] == 'rf52'
    assert vr.deovr_geometry('180-sbs', 'FISHEYE', 180.0)['screenType'] == 'fisheye'


# --- the key --------------------------------------------------------------

def test_key_lifecycle(db):
    assert vr.check_key(db, 'anything') is None
    cfg = vr.regenerate_key(db, 'admin', include_secured=False)
    assert len(cfg['key']) >= 16 and cfg['username'] == 'admin'
    assert vr.check_key(db, cfg['key'])['key'] == cfg['key']
    assert vr.check_key(db, cfg['key'] + 'x') is None
    assert vr.check_key(db, '') is None
    new = vr.regenerate_key(db, 'admin', include_secured=True)
    assert new['key'] != cfg['key'] and new['include_secured'] is True
    assert vr.check_key(db, cfg['key']) is None  # the old one is dead
    vr.disable_key(db)
    assert vr.check_key(db, new['key']) is None


# --- routes ---------------------------------------------------------------

@pytest.fixture
def library(db, tmp_path, monkeypatch):
    """Three finished videos on disk (one VR, one from a secured source), a
    folder pull, a deleted one and a non-video - only the right ones feed."""
    from backend.web_app.routes import vr as vr_routes
    from backend import vr as vr_mod
    files = {}
    for name in ('Holiday.mp4', 'Scene_180_sbs.mkv', 'Secret_360.mp4', 'notes.txt'):
        p = tmp_path / name
        p.write_bytes(b'\0' * 100)
        files[name] = p
    (tmp_path / 'Scene_180_sbs.en.srt').write_text('1\n00:00:01,000 --> 00:00:02,000\nHi\n')

    def paths(download, file_name):
        return [tmp_path / file_name]
    monkeypatch.setattr(vr_routes, 'vr_candidate_paths', lambda d: paths(d, d.get('file') or ''))
    import backend.web_app.helpers as helpers
    from backend.web_app.routes import media as media_routes
    monkeypatch.setattr(helpers, 'candidate_file_paths', paths)
    monkeypatch.setattr(media_routes, 'candidate_file_paths', paths)  # the stream route's own import

    def add(file, source='telegram', **kw):
        row = db.add_download(file=file, status='done', progress=100, downloaded_from=source,
                              message_id=f'vr-{file}', **kw)
        return row['id'] if isinstance(row, dict) else row.id

    ids = {
        'flat': add('Holiday.mp4'),
        'vr': add('Scene_180_sbs.mkv', source='youtube.com', author='Someone'),
        'secret': add('Secret_360.mp4', source='secretsite'),
        'text': add('notes.txt'),
        'folder': add('Folder', source='vps'),
    }
    db.update_download_by_id(ids['folder'], file_count=3)
    # file_meta is JSON text on the row; set it the way the prober does
    import json
    db.update_download_by_id(ids['vr'], file_meta=json.dumps({'duration': 125.5, 'video': {'width': 5760, 'height': 2880}}))
    add('Gone.mp4')
    db.delete_download('Gone.mp4')
    db.add_download_type_map('secretsite', is_secured=True)
    return ids


def _enable(client, auth, include_secured=False):
    res = client.post('/api/settings/vr', json={'action': 'regenerate', 'include_secured': include_secured}, headers=auth)
    assert res.status_code == 200, res.get_data(as_text=True)
    return res.get_json()


def test_settings_roundtrip(client, db, auth):
    assert client.get('/api/settings/vr', headers=auth).get_json()['enabled'] is False
    s = _enable(client, auth)
    assert s['enabled'] and s['urls']['heresphere'].endswith(f"/vr/{s['key']}/heresphere")
    assert s['urls']['deovr'].endswith(f"/vr/{s['key']}/deovr")
    assert s['include_secured'] is False
    s2 = client.post('/api/settings/vr', json={'include_secured': True}, headers=auth).get_json()
    assert s2['include_secured'] is True and s2['key'] == s['key']
    off = client.post('/api/settings/vr', json={'action': 'disable'}, headers=auth).get_json()
    assert off['enabled'] is False
    assert client.get('/api/settings/vr').status_code == 401


def test_feeds_need_a_live_key(client, db, auth):
    assert client.get('/vr/nope/heresphere').status_code == 401
    body = client.get('/vr/nope/heresphere').get_json()
    assert body['access'] == -1
    assert client.get('/vr/nope/deovr').status_code == 401
    assert client.get('/vr/nope/deovr').get_json()['authorized'] == '-1'
    s = _enable(client, auth)
    assert client.get(f"/vr/{s['key']}/heresphere").status_code == 200
    client.post('/api/settings/vr', json={'action': 'disable'}, headers=auth)
    assert client.get(f"/vr/{s['key']}/heresphere").status_code == 401


def test_heresphere_library_and_video(client, db, auth, library):
    s = _enable(client, auth)
    key = s['key']
    res = client.get(f'/vr/{key}/heresphere')
    assert res.status_code == 200 and res.headers['HereSphere-JSON-Version'] == '1'
    body = res.get_json()
    assert body['access'] == 1
    libs = {lib['name']: lib['list'] for lib in body['library']}
    all_urls = libs['All videos']
    # the text file, the folder pull, the deleted and the secured one are out
    assert len(all_urls) == 2
    assert all(u.startswith('http://') and f'/vr/{key}/heresphere/' in u for u in all_urls)
    assert len(libs['VR']) == 1 and libs['VR'][0].endswith(f"/{library['vr']}")
    assert set(libs) == {'All videos', 'VR', 'Telegram', 'youtube.com'}

    v = client.get(f"/vr/{key}/heresphere/{library['vr']}").get_json()
    assert v['title'] == 'Scene_180_sbs' and v['access'] == 1
    assert v['projection'] == 'equirectangular' and v['stereo'] == 'sbs' and v['lens'] == 'Linear'
    assert v['duration'] == 125500  # milliseconds
    assert v['media'][0]['sources'][0]['height'] == 2880
    assert v['media'][0]['sources'][0]['url'].startswith(f"http://localhost/api/video/stream/{library['vr']}?token=")
    assert v['subtitles'] == [{'name': 'English', 'language': 'en',
                               'url': v['subtitles'][0]['url']}]
    assert 'f%3AScene_180_sbs.en.srt' in v['subtitles'][0]['url'] and '&token=' in v['subtitles'][0]['url']
    assert {'name': 'Author:Someone'} in v['tags']
    assert v['writeFavorite'] is False

    # the secured one is 404 on this key, visible on one that includes secured
    assert client.get(f"/vr/{key}/heresphere/{library['secret']}").status_code == 404
    s2 = _enable(client, auth, include_secured=True)
    assert client.get(f"/vr/{s2['key']}/heresphere/{library['secret']}").status_code == 200
    libs2 = {lib['name']: lib['list'] for lib in client.get(f"/vr/{s2['key']}/heresphere").get_json()['library']}
    assert len(libs2['All videos']) == 3 and len(libs2['VR']) == 2


def test_the_media_token_in_the_feed_opens_the_stream(client, db, auth, library):
    s = _enable(client, auth)
    v = client.get(f"/vr/{s['key']}/heresphere/{library['flat']}").get_json()
    url = v['media'][0]['sources'][0]['url'].replace('http://localhost', '')
    res = client.get(url)
    assert res.status_code == 200 and res.get_data() == b'\0' * 100


def test_deovr_library_and_video(client, db, auth, library):
    s = _enable(client, auth)
    key = s['key']
    body = client.get(f'/vr/{key}/deovr').get_json()
    assert body['authorized'] == '1'
    scenes = {sc['name']: sc['list'] for sc in body['scenes']}
    item = next(i for i in scenes['All videos'] if i['title'] == 'Scene_180_sbs')
    assert set(item) == {'title', 'videoLength', 'thumbnailUrl', 'video_url'}
    assert item['videoLength'] == 125
    assert item['video_url'] == f"http://localhost/vr/{key}/deovr/{library['vr']}"

    v = client.get(item['video_url'].replace('http://localhost', '')).get_json()
    assert v['screenType'] == 'dome' and v['stereoMode'] == 'sbs' and v['is3d'] is True
    assert v['encodings'][0]['videoSources'][0]['resolution'] == 2880
    assert v['id'] == library['vr'] and v['videoLength'] == 125
    flat = client.get(f"/vr/{key}/deovr/{library['flat']}").get_json()
    assert flat['screenType'] == 'flat' and flat['is3d'] is False
    assert client.get(f"/vr/{key}/deovr/{library['secret']}").status_code == 404


def test_projection_pick_is_shared_with_the_feed(client, db, auth, library):
    did = library['flat']
    g = client.get(f'/api/downloads/{did}/projection', headers=auth).get_json()
    assert g == {'projection': None, 'detected': 'flat', 'lens': None}
    assert client.put(f'/api/downloads/{did}/projection', json={'projection': 'nope'}, headers=auth).status_code == 400
    assert client.put(f'/api/downloads/{did}/projection', json={'projection': '360-tb'}, headers=auth).status_code == 200
    assert client.get(f'/api/downloads/{did}/projection', headers=auth).get_json()['projection'] == '360-tb'

    s = _enable(client, auth)
    assert client.get(f"/vr/{s['key']}/heresphere/{did}").get_json()['projection'] == 'equirectangular360'
    assert client.get(f"/vr/{s['key']}/deovr/{did}").get_json()['screenType'] == 'sphere'
    libs = {lib['name']: lib['list'] for lib in client.get(f"/vr/{s['key']}/heresphere").get_json()['library']}
    assert len(libs['VR']) == 2  # the flat one now counts as VR

    assert client.put(f'/api/downloads/{did}/projection', json={'projection': None}, headers=auth).status_code == 200
    assert client.get(f"/vr/{s['key']}/deovr/{did}").get_json()['screenType'] == 'flat'
    assert client.put('/api/downloads/999999/projection', json={'projection': 'flat'}, headers=auth).status_code == 404


def test_bare_key_url_answers_in_the_asking_apps_format(client, db, auth, library):
    s = _enable(client, auth)
    hs = client.get(f"/vr/{s['key']}", headers={'HereSphere-JSON-Version': '1'})
    assert hs.status_code == 200 and 'library' in hs.get_json()
    assert hs.headers['HereSphere-JSON-Version'] == '1'
    deo = client.get(f"/vr/{s['key']}")
    assert deo.status_code == 200 and 'scenes' in deo.get_json()
    assert client.get('/vr/nope').status_code == 401
