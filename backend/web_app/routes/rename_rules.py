"""Rename-rule management: CRUD, live preview, and replay over existing files."""
import re
from flask import jsonify, request
from backend.database import get_db
from backend.web_app.base import token_required
from backend.rename import (
    validate_rule, invalidate_rules_cache, preview_rules, apply_to_existing,
    InvalidPattern,
)

# How many real filenames the editor previews against.
PREVIEW_SAMPLE_SIZE = 40


def _rule_payload(data, with_position=False):
    """Pull a rule out of a request body, normalised.

    `position` is only honoured on create, where the presets use it to drop
    themselves into the right place in the chain - order is semantic here, and
    clicking presets in a random sequence would otherwise build a chain that
    silently defeats itself.
    """
    payload = {
        'name': (data.get('name') or '').strip() or None,
        'pattern': (data.get('pattern') or '').strip(),
        'replacement': data.get('replacement') or '',
        'enabled': bool(data.get('enabled', True)),
        'source': (data.get('source') or '').strip() or None,
        'stop_on_match': bool(data.get('stop_on_match', False)),
    }
    if with_position and data.get('position') is not None:
        try:
            payload['position'] = int(data['position'])
        except (TypeError, ValueError):
            pass
    return payload


class RenameRulesRoutesMixin:
    def register_rename_rules_routes(self):
        @self.app.route("/api/settings/rename-rules", methods=["GET"])
        @token_required
        def list_rename_rules():
            return jsonify({'rules': get_db().get_rename_rules()})

        @self.app.route("/api/settings/rename-rules", methods=["POST"])
        @token_required
        def create_rename_rule():
            payload = _rule_payload(request.json or {}, with_position=True)
            try:
                validate_rule(payload['pattern'], payload['replacement'])
            except InvalidPattern as e:
                return jsonify({'error': str(e)}), 400

            rule = get_db().add_rename_rule(**payload)
            invalidate_rules_cache()
            return jsonify({'rule': rule, 'rules': get_db().get_rename_rules()})

        @self.app.route("/api/settings/rename-rules/<int:rule_id>", methods=["PUT"])
        @token_required
        def update_rename_rule(rule_id):
            data = request.json or {}
            payload = _rule_payload(data)
            try:
                validate_rule(payload['pattern'], payload['replacement'])
            except InvalidPattern as e:
                return jsonify({'error': str(e)}), 400

            rule = get_db().update_rename_rule(rule_id, **payload)
            if not rule:
                return jsonify({'error': 'Rule not found'}), 404
            invalidate_rules_cache()
            return jsonify({'rule': rule, 'rules': get_db().get_rename_rules()})

        @self.app.route("/api/settings/rename-rules/<int:rule_id>", methods=["DELETE"])
        @token_required
        def delete_rename_rule(rule_id):
            if not get_db().delete_rename_rule(rule_id):
                return jsonify({'error': 'Rule not found'}), 404
            invalidate_rules_cache()
            return jsonify({'rules': get_db().get_rename_rules()})

        @self.app.route("/api/settings/rename-rules/reorder", methods=["POST"])
        @token_required
        def reorder_rename_rules():
            """Rules run top to bottom, so order is part of the configuration."""
            ids = (request.json or {}).get('ids') or []
            if not isinstance(ids, list):
                return jsonify({'error': 'ids must be a list'}), 400
            get_db().reorder_rename_rules([int(i) for i in ids])
            invalidate_rules_cache()
            return jsonify({'rules': get_db().get_rename_rules()})

        @self.app.route("/api/settings/rename-rules/test", methods=["POST"])
        @token_required
        def test_rename_rules():
            """Preview a rule against real filenames from the library.

            A draft rule (not yet saved) can be passed in `rule`; it is
            previewed on its own so the editor shows exactly what that one
            pattern does. Without it, the saved chain is previewed.
            """
            data = request.json or {}
            draft = data.get('rule')
            rules = None

            if draft:
                payload = _rule_payload(draft)
                try:
                    compiled = validate_rule(payload['pattern'], payload['replacement'])
                except InvalidPattern as e:
                    return jsonify({'error': str(e)}), 400
                rules = [({**payload, 'id': None}, compiled)]

            samples = data.get('samples')
            if samples:
                rows = [{'file': s, 'downloaded_from': data.get('source')} for s in samples[:PREVIEW_SAMPLE_SIZE]]
            else:
                db = get_db()
                downloads = [d for d in db.get_all_downloads() if d.get('file')]
                downloads.sort(key=lambda d: d.get('created_at') or '', reverse=True)
                # Distinct names only - a preview full of near-identical rows
                # from one series isn't informative.
                seen, rows = set(), []
                for d in downloads:
                    if d['file'] in seen:
                        continue
                    seen.add(d['file'])
                    rows.append(d)

            # Score the whole library, not just the newest page of it. A rule
            # scoped to one source, or one that only targets older filenames,
            # otherwise previews as "matches nothing" purely because the recent
            # rows happen to come from somewhere else.
            results = [
                preview_rules(row['file'], row.get('downloaded_from'), rules=rules)
                for row in rows
            ]
            changed = [r for r in results if r['changed']]

            # Lead with the matches - they are what the user is checking - then
            # pad with untouched names so it is visible what is left alone.
            shown = changed[:PREVIEW_SAMPLE_SIZE]
            if len(shown) < PREVIEW_SAMPLE_SIZE:
                shown += [r for r in results if not r['changed']][:PREVIEW_SAMPLE_SIZE - len(shown)]

            return jsonify({
                'results': shown,
                'changed': len(changed),
                'total': len(results),
                'scanned': len(results),
            })

        @self.app.route("/api/settings/rename-rules/apply", methods=["POST"])
        @token_required
        def apply_rename_rules():
            """Replay the chain over completed downloads.

            Defaults to a dry run: the caller gets the full before/after plan
            and has to opt in with `{"dry_run": false}` to touch any file.
            """
            data = request.json or {}
            dry_run = data.get('dry_run', True)
            return jsonify(apply_to_existing(dry_run=bool(dry_run)))
