import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import {
  ColumnTypeEnum,
  DriverAdapterError,
  type ArgType,
  type ColumnType,
  type IsolationLevel,
  type MappedError,
  type SqlDriverAdapter,
  type SqlMigrationAwareDriverAdapterFactory,
  type SqlQuery,
  type SqlResultSet,
  type Transaction,
  type TransactionOptions,
} from '@prisma/driver-adapter-utils';

/**
 * A Prisma driver adapter for Node's built-in node:sqlite, so the conductor needs no native module (nothing
 * to compile on a Raspberry Pi) and no Prisma engine binary. Modelled on @prisma/adapter-better-sqlite3,
 * with two deliberate differences:
 *
 *  - Timestamps are written as `Date#toISOString()` ("...000Z"), the format the data has always had.
 *    (@prisma/adapter-better-sqlite3 writes "...000+00:00"; mixing the two would break text comparisons.)
 *  - Queries outside a transaction wait while one is open. There is one SQLite connection: without this,
 *    a write from another async task would run inside someone else's transaction and be lost if it rolled back.
 *
 * Used by the Prisma client (src/db/database.ts) and, in development, by Prisma's schema engine to
 * generate migrations (src/db/schema-engine.ts).
 */

export const ADAPTER_NAME = 'conductor-node-sqlite';

/** A lock for the single connection: a transaction holds it until it ends. */
class Mutex {
  #tail: Promise<void> = Promise.resolve();

  /** Resolves with the release function once the lock is free. */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => held);
    let released = false;
    return previous.then(() => () => {
      if (released) return;
      released = true;
      release();
    });
  }
}

/** Column type from the declared type of a result column (as Prisma's migrations declare them). */
export const columnTypeOf = (declared: string | null): ColumnType | null => {
  switch (declared?.toUpperCase()) {
    case undefined:
    case '':
      return null;
    case 'INT':
    case 'INTEGER':
    case 'TINYINT':
    case 'SMALLINT':
    case 'MEDIUMINT':
    case 'INT2':
    case 'SERIAL':
      return ColumnTypeEnum.Int32;
    case 'BIGINT':
    case 'INT8':
    case 'UNSIGNED BIG INT':
      return ColumnTypeEnum.Int64;
    case 'REAL':
    case 'DOUBLE':
    case 'DOUBLE PRECISION':
    case 'NUMERIC':
      return ColumnTypeEnum.Double;
    case 'FLOAT':
      return ColumnTypeEnum.Float;
    case 'DECIMAL':
      return ColumnTypeEnum.Numeric;
    case 'DATETIME':
    case 'TIMESTAMP':
      return ColumnTypeEnum.DateTime;
    case 'DATE':
      return ColumnTypeEnum.Date;
    case 'TIME':
      return ColumnTypeEnum.Time;
    case 'TEXT':
    case 'CLOB':
    case 'CHARACTER':
    case 'VARCHAR':
    case 'VARYING CHARACTER':
    case 'NCHAR':
    case 'NATIVE CHARACTER':
    case 'NVARCHAR':
      return ColumnTypeEnum.Text;
    case 'BLOB':
      return ColumnTypeEnum.Bytes;
    case 'BOOLEAN':
      return ColumnTypeEnum.Boolean;
    case 'JSONB':
      return ColumnTypeEnum.Json;
    default:
      return null;
  }
};

/** Column type from a value, for expression columns (no declared type). */
const inferColumnType = (value: unknown): ColumnType => {
  if (typeof value === 'string') return ColumnTypeEnum.Text;
  if (typeof value === 'bigint') return ColumnTypeEnum.Int64;
  if (typeof value === 'number') return ColumnTypeEnum.UnknownNumber;
  if (value instanceof Uint8Array) return ColumnTypeEnum.Bytes;
  throw new Error(`unexpected value of type ${typeof value} in a result set`);
};

const columnTypesOf = (declared: (string | null)[], rows: unknown[][]): ColumnType[] =>
  declared.map((d, i) => {
    const fromDeclaration = columnTypeOf(d);
    if (fromDeclaration !== null) return fromDeclaration;
    const sample = rows.find((row) => row[i] !== null)?.[i];
    return sample === undefined ? ColumnTypeEnum.Int32 : inferColumnType(sample);
  });

/** A result value as Prisma expects it (integers are read as BigInt so none is ever rounded). */
const resultValue = (value: unknown, type: ColumnType): unknown => {
  if (typeof value === 'number' && (type === ColumnTypeEnum.Int32 || type === ColumnTypeEnum.Int64) && !Number.isInteger(value)) {
    return Math.trunc(value);
  }
  if ((typeof value === 'number' || typeof value === 'bigint') && type === ColumnTypeEnum.DateTime) {
    return new Date(Number(value)).toISOString();
  }
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  return value;
};

/** A query argument as node:sqlite takes it. */
export const sqliteArg = (arg: unknown, type: ArgType | undefined): SQLInputValue => {
  if (arg === null || arg === undefined) return null;
  const scalar = type?.scalarType;
  if (typeof arg === 'string' && scalar === 'int') return Number.parseInt(arg, 10);
  if (typeof arg === 'string' && (scalar === 'float' || scalar === 'decimal')) return Number.parseFloat(arg);
  if (typeof arg === 'string' && scalar === 'bigint') return BigInt(arg);
  if (typeof arg === 'boolean') return arg ? 1 : 0;
  if (typeof arg === 'string' && scalar === 'datetime') return new Date(arg).toISOString();
  if (arg instanceof Date) return arg.toISOString(); // throws RangeError for an invalid Date: never stored
  if (typeof arg === 'string' && scalar === 'bytes') return Buffer.from(arg, 'base64');
  if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'bigint' || arg instanceof Uint8Array) return arg;
  return JSON.stringify(arg);
};

/** SQLite's error as Prisma understands it (extended result codes: https://www.sqlite.org/rescode.html). */
export const mappedError = (err: unknown): MappedError => {
  const e = err as { errcode?: unknown; message?: unknown };
  const code = typeof e.errcode === 'number' ? e.errcode : 1;
  const message = typeof e.message === 'string' ? e.message : String(err);
  const fields = () => message.split('constraint failed: ').at(1)?.split(', ').map((f) => f.split('.').pop() ?? f);
  switch (code) {
    case 2067: // SQLITE_CONSTRAINT_UNIQUE
    case 1555: {
      // SQLITE_CONSTRAINT_PRIMARYKEY
      const f = fields();
      const table = message.split('constraint failed: ').at(1)?.split('.').at(0);
      return { kind: 'UniqueConstraintViolation', ...(f ? { constraint: { fields: f } } : {}), ...(table ? { table } : {}) };
    }
    case 1299: {
      // SQLITE_CONSTRAINT_NOTNULL
      const f = fields();
      return { kind: 'NullConstraintViolation', ...(f ? { constraint: { fields: f } } : {}) };
    }
    case 787: // SQLITE_CONSTRAINT_FOREIGNKEY
      return { kind: 'ForeignKeyConstraintViolation', constraint: { foreignKey: {} } };
    default:
      if ((code & 0xff) === 5) return { kind: 'SocketTimeout' }; // SQLITE_BUSY: another connection holds the lock
      if (message.startsWith('no such table')) return { kind: 'TableDoesNotExist', table: message.split(': ').at(1) ?? '' };
      if (message.startsWith('no such column')) return { kind: 'ColumnNotFound', column: message.split(': ').at(1) ?? '' };
      return { kind: 'sqlite', extendedCode: code, message };
  }
};

const fail = (err: unknown): never => {
  if (err instanceof DriverAdapterError) throw err;
  throw new DriverAdapterError(mappedError(err));
};

class Queryable {
  readonly provider = 'sqlite' as const;
  readonly adapterName = ADAPTER_NAME;
  protected readonly client: DatabaseSync;

  constructor(client: DatabaseSync) {
    this.client = client;
  }

  async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    return this.perform(query);
  }

  async executeRaw(query: SqlQuery): Promise<number> {
    try {
      return Number(this.client.prepare(query.sql).run(...this.args(query)).changes);
    } catch (err) {
      return fail(err);
    }
  }

  protected perform(query: SqlQuery): SqlResultSet {
    try {
      const stmt: StatementSync = this.client.prepare(query.sql);
      const args = this.args(query);
      const columns = stmt.columns();
      if (columns.length === 0) {
        const result = stmt.run(...args);
        return { columnNames: [], columnTypes: [], rows: [], lastInsertId: String(result.lastInsertRowid) };
      }
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      const rows = stmt.all(...args) as unknown as unknown[][];
      const columnTypes = columnTypesOf(
        columns.map((c) => c.type),
        rows,
      );
      return {
        columnNames: columns.map((c) => c.name),
        columnTypes,
        rows: rows.map((row) => row.map((v, i) => resultValue(v, columnTypes[i] ?? ColumnTypeEnum.Text))),
      };
    } catch (err) {
      return fail(err);
    }
  }

  protected args(query: SqlQuery): SQLInputValue[] {
    return query.args.map((arg, i) => sqliteArg(arg, query.argTypes[i]));
  }
}

class NodeSqliteTransaction extends Queryable implements Transaction {
  readonly options: TransactionOptions = { usePhantomQuery: false };
  readonly #release: () => void;

  constructor(client: DatabaseSync, release: () => void) {
    super(client);
    this.#release = release;
  }

  // Prisma sends COMMIT / ROLLBACK itself (usePhantomQuery: false), then calls these to end the transaction.
  async commit(): Promise<void> {
    this.#end();
  }

  async rollback(): Promise<void> {
    this.#end();
  }

  /** Never leave the one connection inside a transaction (e.g. after a failed COMMIT). */
  #end(): void {
    try {
      if (this.client.isOpen && this.client.isTransaction) this.client.exec('ROLLBACK');
    } finally {
      this.#release();
    }
  }

  async createSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `SAVEPOINT ${name}`, args: [], argTypes: [] });
  }

  async rollbackToSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `ROLLBACK TO ${name}`, args: [], argTypes: [] });
  }

  async releaseSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `RELEASE SAVEPOINT ${name}`, args: [], argTypes: [] });
  }
}

export class NodeSqliteAdapter extends Queryable implements SqlDriverAdapter {
  readonly #mutex = new Mutex();
  readonly #closeOnDispose: boolean;

  constructor(client: DatabaseSync, options: { closeOnDispose?: boolean } = {}) {
    super(client);
    this.#closeOnDispose = options.closeOnDispose ?? true;
  }

  override async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    const release = await this.#mutex.acquire();
    try {
      return this.perform(query);
    } finally {
      release();
    }
  }

  override async executeRaw(query: SqlQuery): Promise<number> {
    const release = await this.#mutex.acquire();
    try {
      return await super.executeRaw(query);
    } finally {
      release();
    }
  }

  async executeScript(script: string): Promise<void> {
    const release = await this.#mutex.acquire();
    try {
      this.client.exec(script);
    } catch (err) {
      fail(err);
    } finally {
      release();
    }
  }

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    if (isolationLevel && isolationLevel !== 'SERIALIZABLE') {
      throw new DriverAdapterError({ kind: 'InvalidIsolationLevel', level: isolationLevel });
    }
    const release = await this.#mutex.acquire();
    try {
      this.client.exec('BEGIN');
    } catch (err) {
      release();
      return fail(err);
    }
    return new NodeSqliteTransaction(this.client, release);
  }

  getConnectionInfo() {
    return { supportsRelationJoins: false };
  }

  async dispose(): Promise<void> {
    if (this.#closeOnDispose && this.client.isOpen) this.client.close();
  }
}

export interface NodeSqliteAdapterOptions {
  /** Connection for the shadow database Prisma's schema engine diffs against (default: a new in-memory one). */
  shadow?: () => DatabaseSync;
  /** Close the connection when Prisma disconnects (default true). */
  closeOnDispose?: boolean;
}

/**
 * The adapter factory Prisma takes (`new PrismaClient({ adapter })`). It wraps one already-open connection,
 * so the app controls how it is opened (pragmas, read-only, migrations) and an in-memory database is shared
 * with the code that created it.
 */
export class NodeSqliteAdapterFactory implements SqlMigrationAwareDriverAdapterFactory {
  readonly provider = 'sqlite' as const;
  readonly adapterName = ADAPTER_NAME;
  readonly #client: DatabaseSync;
  readonly #options: NodeSqliteAdapterOptions;

  constructor(client: DatabaseSync, options: NodeSqliteAdapterOptions = {}) {
    this.#client = client;
    this.#options = options;
  }

  async connect(): Promise<SqlDriverAdapter> {
    return new NodeSqliteAdapter(this.#client, { closeOnDispose: this.#options.closeOnDispose ?? true });
  }

  async connectToShadowDb(): Promise<SqlDriverAdapter> {
    return new NodeSqliteAdapter(this.#options.shadow?.() ?? new DatabaseSync(':memory:'));
  }
}
