import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../plugins/i18n', () => ({ i18n: { global: { t: (key) => key } } }));
vi.mock('../../shared/utils', () => ({ openExternalLink: vi.fn() }));
vi.mock('../../stores', () => ({ useModalStore: () => ({ alert: vi.fn(), confirm: vi.fn() }) }));

import { SQLiteService } from '../sqlite';

describe('SQLite read transports', () => {
    let bridge;
    let service;

    beforeEach(() => {
        bridge = { Execute: vi.fn(), ExecuteJson: vi.fn(), ExecuteNonQuery: vi.fn() };
        vi.stubGlobal('SQLite', bridge);
        service = new SQLiteService();
    });

    afterEach(() => vi.unstubAllGlobals());

    it('keeps the normal Windows transport unchanged for existing callers', async () => {
        const rows = [[{ Value: null }, 7, 'text']];
        bridge.Execute.mockResolvedValue(rows);
        const callback = vi.fn();
        const args = { '@id': 7 };
        await service.execute(callback, 'SELECT * FROM example WHERE id = @id', args);
        expect(bridge.Execute).toHaveBeenCalledWith('SELECT * FROM example WHERE id = @id', args);
        expect(bridge.ExecuteJson).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith(rows[0]);
    });

    it('uses the existing serialized bridge for an explicitly requested bulk read', async () => {
        bridge.ExecuteJson.mockResolvedValue('[[1,"one"],[2,"two"]]');
        const rows = [];
        const args = { '@limit': 10000 };
        await service.execute((row) => rows.push(row), 'SELECT id, name FROM example LIMIT @limit', args, {
            bulk: true
        });
        expect(bridge.ExecuteJson).toHaveBeenCalledWith('SELECT id, name FROM example LIMIT @limit', args);
        expect(bridge.Execute).not.toHaveBeenCalled();
        expect(bridge.ExecuteNonQuery).not.toHaveBeenCalled();
        expect(rows).toEqual([
            [1, 'one'],
            [2, 'two']
        ]);
    });

    it('restores SQL nulls without changing scalar values or JSON-looking text', async () => {
        bridge.ExecuteJson.mockResolvedValue('[[{},null,7,2.5,"{}","{\\"Value\\":null}","AQI="]]');
        const rows = [];
        await service.execute((row) => rows.push(row), 'SELECT values_from_example', null, { bulk: true });
        expect(rows).toEqual([[null, null, 7, 2.5, '{}', '{"Value":null}', 'AQI=']]);
    });

    it('keeps empty results and failures on the normal error path', async () => {
        const callback = vi.fn();
        bridge.ExecuteJson.mockResolvedValueOnce('[]').mockRejectedValueOnce(new Error('Read failed.'));
        await service.execute(callback, 'SELECT id FROM example', null, { bulk: true });
        expect(callback).not.toHaveBeenCalled();
        await expect(service.execute(callback, 'SELECT id FROM example', null, { bulk: true })).rejects.toThrow(
            'Read failed.'
        );
    });

    it('rejects invalid JSON before invoking callbacks', async () => {
        bridge.ExecuteJson.mockResolvedValue('not JSON');
        const callback = vi.fn();
        await expect(service.execute(callback, 'SELECT id FROM example', null, { bulk: true })).rejects.toThrow();
        expect(callback).not.toHaveBeenCalled();
    });
});
