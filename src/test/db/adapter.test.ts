import { DatabaseSync } from 'node:sqlite';
import { ColumnTypeEnum, DriverAdapterError, type SqlQuery } from '@prisma/driver-adapter-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTER_NAME, columnTypeOf, mappedError, NodeSqliteAdapter, NodeSqliteAdapterFactory, sqliteArg } from '../../db/adapter.ts';
import { openDatabase } from '../../db/database.ts';

const q = (sql: string, args: unknown[] = [], types: SqlQuery['argTypes'] = []): SqlQuery => ({
  sql,
  args,
  argTypes: types.length > 0 ? types : args.map(() => ({ scalarType: 'unknown', arity: 'scalar' })),
});
const T0 = new Date('2026-07-01T11:00:00.000Z');

describe('columnTypeOf', () => {
  it.each([
    ['INTEGER', ColumnTypeEnum.Int32],
    ['int', ColumnTypeEnum.Int32],
    ['BIGINT', ColumnTypeEnum.Int64],
    ['REAL', ColumnTypeEnum.Double],
    ['FLOAT', ColumnTypeEnum.Float],
    ['DECIMAL', ColumnTypeEnum.Numeric],
    ['DATETIME', ColumnTypeEnum.DateTime],
    ['DATE', ColumnTypeEnum.Date],
    ['TIME', ColumnTypeEnum.Time],
    ['TEXT', ColumnTypeEnum.Text],
    ['BLOB', ColumnTypeEnum.Bytes],
    ['BOOLEAN', ColumnTypeEnum.Boolean],
    ['JSONB', ColumnTypeEnum.Json],
    ['', null],
    [null, null],
    ['GEOMETRY', null],
  ])('%s', (declared, type) => expect(columnTypeOf(declared)).toBe(type));
});

describe('sqliteArg', () => {
  it('writes times as Date#toISOString() (with Z), the format the data has always had', () => {
    expect(sqliteArg(T0, undefined)).toBe('2026-07-01T11:00:00.000Z');
    expect(sqliteArg('2026-07-01T06:00:00-05:00', { scalarType: 'datetime', arity: 'scalar' })).toBe('2026-07-01T11:00:00.000Z');
    expect(() => sqliteArg(new Date(Number.NaN), undefined)).toThrow(RangeError);
  });

  it.each([
    [null, undefined, null],
    [undefined, undefined, null],
    [true, undefined, 1],
    [false, undefined, 0],
    ['42', { scalarType: 'int', arity: 'scalar' }, 42],
    ['2.5', { scalarType: 'float', arity: 'scalar' }, 2.5],
    ['2.5', { scalarType: 'decimal', arity: 'scalar' }, 2.5],
    ['9007199254740993', { scalarType: 'bigint', arity: 'scalar' }, 9007199254740993n],
    ['text', { scalarType: 'string', arity: 'scalar' }, 'text'],
    [3, undefined, 3],
    [{ a: 1 }, undefined, '{"a":1}'],
  ] as const)('%o (%o) → %o', (arg, type, expected) => expect(sqliteArg(arg, type)).toEqual(expected));

  it('decodes bytes sent as base64', () => {
    expect(sqliteArg('AQID', { scalarType: 'bytes', arity: 'scalar' })).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe('mappedError', () => {
  it.each([
    [{ errcode: 2067, message: 'UNIQUE constraint failed: zone.device_id, zone.station' }, { kind: 'UniqueConstraintViolation', constraint: { fields: ['device_id', 'station'] }, table: 'zone' }],
    [{ errcode: 1555, message: 'UNIQUE constraint failed: zone.zone_key' }, { kind: 'UniqueConstraintViolation', constraint: { fields: ['zone_key'] }, table: 'zone' }],
    [{ errcode: 1299, message: 'NOT NULL constraint failed: zone.name' }, { kind: 'NullConstraintViolation', constraint: { fields: ['name'] } }],
    [{ errcode: 787, message: 'FOREIGN KEY constraint failed' }, { kind: 'ForeignKeyConstraintViolation', constraint: { foreignKey: {} } }],
    [{ errcode: 5, message: 'database is locked' }, { kind: 'SocketTimeout' }],
    [{ errcode: 517, message: 'database is locked' }, { kind: 'SocketTimeout' }], // SQLITE_BUSY_SNAPSHOT
    [{ errcode: 1, message: 'no such table: nope' }, { kind: 'TableDoesNotExist', table: 'nope' }],
    [{ errcode: 1, message: 'no such column: nope' }, { kind: 'ColumnNotFound', column: 'nope' }],
    [{ errcode: 13, message: 'database or disk is full' }, { kind: 'sqlite', extendedCode: 13, message: 'database or disk is full' }],
    [new Error('no code at all'), { kind: 'sqlite', extendedCode: 1, message: 'no code at all' }],
  ])('%o', (err, mapped) => expect(mappedError(err)).toEqual(mapped));
});

describe('NodeSqliteAdapter', () => {
  let client: DatabaseSync;
  let adapter: NodeSqliteAdapter;

  beforeEach(() => {
    client = new DatabaseSync(':memory:');
    client.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, r REAL, s TEXT NOT NULL DEFAULT '', at DATETIME, b BLOB, ok BOOLEAN, j JSONB, UNIQUE (s))`);
    adapter = new NodeSqliteAdapter(client);
  });

  afterEach(() => {
    if (client.isOpen) client.close();
  });

  it('returns typed columns, reading integers without losing precision', async () => {
    await adapter.executeRaw(q('INSERT INTO t (n, r, s, at, b, ok, j) VALUES (?, ?, ?, ?, ?, ?, ?)', [9007199254740993n, 2.5, 'x', T0, Buffer.from([1, 2]), true, '{"a":1}']));
    await adapter.executeRaw(q(`INSERT INTO t (n, s, at) VALUES (42, 'y', 1782903600000)`)); // a time stored as milliseconds

    const result = await adapter.queryRaw(q('SELECT n, r, s, at, b, ok, j, n + 1 AS expr, NULL AS empty FROM t ORDER BY id'));

    expect(result.columnNames).toEqual(['n', 'r', 's', 'at', 'b', 'ok', 'j', 'expr', 'empty']);
    expect(result.columnTypes).toEqual([
      ColumnTypeEnum.Int32,
      ColumnTypeEnum.Double,
      ColumnTypeEnum.Text,
      ColumnTypeEnum.DateTime,
      ColumnTypeEnum.Bytes,
      ColumnTypeEnum.Boolean,
      ColumnTypeEnum.Json,
      ColumnTypeEnum.Int64, // an expression: inferred from its values
      ColumnTypeEnum.Int32, // all NULL: anything will do
    ]);
    expect(result.rows).toEqual([
      ['9007199254740993', 2.5, 'x', '2026-07-01T11:00:00.000Z', new Uint8Array([1, 2]), 1, '{"a":1}', '9007199254740994', null],
      [42, null, 'y', '2026-07-01T11:00:00.000Z', null, null, null, 43, null],
    ]);
  });

  it('runs statements without a result set through queryRaw too, with the id of an inserted row', async () => {
    const result = await adapter.queryRaw(q(`INSERT INTO t (s) VALUES ('z')`));

    expect(result).toEqual({ columnNames: [], columnTypes: [], rows: [], lastInsertId: '1' });
    expect(await adapter.queryRaw(q(`INSERT INTO t (s) VALUES ('w') RETURNING id, s`))).toMatchObject({ columnNames: ['id', 's'], rows: [[2, 'w']] });
  });

  it('returns the number of changed rows', async () => {
    await adapter.executeScript(`INSERT INTO t (s) VALUES ('a'); INSERT INTO t (s) VALUES ('b'); INSERT INTO t (s) VALUES ('c')`);

    expect(await adapter.executeRaw(q(`UPDATE t SET n = 1 WHERE s <> ?`, ['a']))).toBe(2);
  });

  it('turns SQLite errors into driver adapter errors Prisma understands', async () => {
    await adapter.executeRaw(q(`INSERT INTO t (s) VALUES ('a')`));

    const unique = await adapter.executeRaw(q(`INSERT INTO t (s) VALUES ('a')`)).catch((e: unknown) => e);
    expect(unique).toBeInstanceOf(DriverAdapterError);
    expect((unique as DriverAdapterError).cause).toMatchObject({ kind: 'UniqueConstraintViolation', constraint: { fields: ['s'] } });
    await expect(adapter.queryRaw(q('SELECT * FROM nope'))).rejects.toMatchObject({ cause: { kind: 'TableDoesNotExist', table: 'nope' } });
    await expect(adapter.executeScript('CREATE TABLE t (x)')).rejects.toMatchObject({ cause: { kind: 'sqlite', message: 'table t already exists' } });
  });

  it('commits a transaction when Prisma sends COMMIT, and rolls one back on ROLLBACK', async () => {
    const tx = await adapter.startTransaction();
    expect(tx.options).toEqual({ usePhantomQuery: false });
    await tx.executeRaw(q(`INSERT INTO t (s) VALUES ('kept')`));
    await tx.executeRaw(q('COMMIT'));
    await tx.commit();

    const tx2 = await adapter.startTransaction('SERIALIZABLE');
    await tx2.executeRaw(q(`INSERT INTO t (s) VALUES ('dropped')`));
    await tx2.executeRaw(q('ROLLBACK'));
    await tx2.rollback();

    expect((await adapter.queryRaw(q('SELECT s FROM t'))).rows).toEqual([['kept']]);
  });

  it('never leaves the connection inside a transaction, e.g. after a failed COMMIT', async () => {
    const tx = await adapter.startTransaction();
    await tx.executeRaw(q(`INSERT INTO t (s) VALUES ('half')`));
    await tx.commit(); // released without COMMIT having gone through

    expect(client.isTransaction).toBe(false);
    expect((await adapter.queryRaw(q('SELECT count(*) AS n FROM t'))).rows).toEqual([[0]]);
  });

  it('supports savepoints', async () => {
    const tx = await adapter.startTransaction();
    await tx.executeRaw(q(`INSERT INTO t (s) VALUES ('outer')`));
    await tx.createSavepoint?.('sp1');
    await tx.executeRaw(q(`INSERT INTO t (s) VALUES ('inner')`));
    await tx.rollbackToSavepoint?.('sp1');
    await tx.releaseSavepoint?.('sp1');
    await tx.executeRaw(q('COMMIT'));
    await tx.commit();

    expect((await adapter.queryRaw(q('SELECT s FROM t'))).rows).toEqual([['outer']]);
  });

  it('refuses isolation levels SQLite does not have', async () => {
    await expect(adapter.startTransaction('READ COMMITTED')).rejects.toMatchObject({ cause: { kind: 'InvalidIsolationLevel', level: 'READ COMMITTED' } });
  });

  it('makes queries from outside wait while a transaction is open, so they are never rolled back with it', async () => {
    const tx = await adapter.startTransaction();
    await tx.executeRaw(q(`INSERT INTO t (s) VALUES ('in the transaction')`));
    const outside = adapter.executeRaw(q(`INSERT INTO t (s) VALUES ('from outside')`));
    const another = adapter.startTransaction();
    await new Promise((r) => setImmediate(r));
    expect(client.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 }); // still waiting

    await tx.executeRaw(q('ROLLBACK'));
    await tx.rollback();
    await outside;
    const second = await another;
    await second.executeRaw(q('COMMIT'));
    await second.commit();

    expect((await adapter.queryRaw(q('SELECT s FROM t'))).rows).toEqual([['from outside']]);
  });

  it('closes the connection when disposed, unless told not to', async () => {
    const kept = new DatabaseSync(':memory:');
    await new NodeSqliteAdapter(kept, { closeOnDispose: false }).dispose();
    expect(kept.isOpen).toBe(true);
    kept.close();

    await adapter.dispose();
    expect(client.isOpen).toBe(false);
    await adapter.dispose(); // twice is fine
  });

  it('names itself and says it can\'t join relations in one query', () => {
    expect(adapter.provider).toBe('sqlite');
    expect(adapter.adapterName).toBe(ADAPTER_NAME);
    expect(adapter.getConnectionInfo()).toEqual({ supportsRelationJoins: false });
  });
});

describe('NodeSqliteAdapterFactory', () => {
  it('hands out the connection it was given, and a separate one for the shadow database', async () => {
    const client = new DatabaseSync(':memory:');
    client.exec('CREATE TABLE marker (x)');
    const factory = new NodeSqliteAdapterFactory(client);

    const main = await factory.connect();
    expect((await main.queryRaw(q(`SELECT name FROM sqlite_schema WHERE name = 'marker'`))).rows).toEqual([['marker']]);
    const shadow = await factory.connectToShadowDb();
    expect((await shadow.queryRaw(q(`SELECT count(*) AS n FROM sqlite_schema`))).rows).toEqual([[0]]);
    await shadow.dispose();

    const custom = new DatabaseSync(':memory:');
    custom.exec('CREATE TABLE shadow_marker (x)');
    const withShadow = new NodeSqliteAdapterFactory(client, { shadow: () => custom });
    expect((await (await withShadow.connectToShadowDb()).queryRaw(q(`SELECT name FROM sqlite_schema`))).rows).toEqual([['shadow_marker']]);
    await main.dispose();
  });
});

describe('through Prisma', () => {
  it('round-trips times, JSON, booleans and numbers, and stores times as before', async () => {
    const db = openDatabase(':memory:');
    await db.prisma.serviceRun.create({
      data: { startedAt: new Date('2026-07-01T11:00:00.123Z'), mode: 'once', dryRun: true, pid: 2_147_483_647, configHash: 'h', config: { a: [1, { b: null }], c: 'd' }, heartbeatAt: T0 },
    });

    expect(await db.prisma.serviceRun.findFirst({ select: { startedAt: true, dryRun: true, pid: true, config: true } })).toEqual({
      startedAt: new Date('2026-07-01T11:00:00.123Z'),
      dryRun: true,
      pid: 2_147_483_647,
      config: { a: [1, { b: null }], c: 'd' },
    });
    expect(db.sqlite.prepare('SELECT started_at, dry_run, typeof(config_json) AS j FROM service_run').get()).toEqual({ started_at: '2026-07-01T11:00:00.123Z', dry_run: 1, j: 'text' });
    expect(await db.prisma.serviceRun.count({ where: { startedAt: { gt: T0 } } })).toBe(1); // text comparison works
    await db.close();
  });

  it('reports constraint violations with SQLite\'s detail attached', async () => {
    const db = openDatabase(':memory:');
    await db.prisma.openAlert.create({ data: { alertKey: 'device:d', kind: 'device', state: 'offline', since: T0 } });

    await expect(db.prisma.openAlert.create({ data: { alertKey: 'device:d', kind: 'device', state: 'offline', since: T0 } })).rejects.toMatchObject({
      code: 'P2002',
      meta: { driverAdapterError: { cause: { kind: 'UniqueConstraintViolation' } } },
    });
    await expect(db.prisma.zoneState.create({ data: { zoneKey: 'nope:1', evaluatedAt: T0 } })).rejects.toMatchObject({ code: 'P2003' });
    await db.close();
  });

  it('keeps a write from outside an interactive transaction out of that transaction', async () => {
    const db = openDatabase(':memory:');
    await db.prisma.zone.create({ data: { zoneKey: 'd:1', deviceId: 'd', station: 1, name: 'Z', firstSeenAt: T0, lastSeenAt: T0 } });

    const failing = db.prisma
      .$transaction(async (tx) => {
        await tx.zone.update({ where: { zoneKey: 'd:1' }, data: { name: 'in the transaction' } });
        await new Promise((r) => setTimeout(r, 20)); // the outside write is attempted meanwhile
        throw new Error('rollback');
      })
      .catch((e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 5));
    const outside = db.prisma.zone.update({ where: { zoneKey: 'd:1' }, data: { lastSeenAt: new Date(T0.getTime() + 1000) } });

    expect(await failing).toBe('rollback');
    await outside;
    expect(await db.prisma.zone.findUnique({ where: { zoneKey: 'd:1' } })).toMatchObject({ name: 'Z', lastSeenAt: new Date(T0.getTime() + 1000) });
    await db.close();
  });
});
