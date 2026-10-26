/**
 * Adapter registry: maps a config value (for example EVENT_BUS=redis-streams)
 * to a factory. Adding a new backend means registering one more factory and
 * using its name in config; no call site changes.
 */

export type AdapterFactory<T, Deps> = (deps: Deps) => T | Promise<T>;

export class UnknownAdapterError extends Error {
  constructor(
    readonly kind: string,
    readonly requested: string,
    readonly available: string[]
  ) {
    super(`Unknown ${kind} adapter "${requested}". Available: ${available.join(', ') || '(none)'}`);
    this.name = 'UnknownAdapterError';
  }
}

export class AdapterRegistry<T, Deps> {
  private readonly factories = new Map<string, AdapterFactory<T, Deps>>();

  constructor(readonly kind: string) {}

  register(name: string, factory: AdapterFactory<T, Deps>): this {
    if (this.factories.has(name)) {
      throw new Error(`${this.kind} adapter "${name}" is already registered`);
    }
    this.factories.set(name, factory);
    return this;
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  names(): string[] {
    return [...this.factories.keys()].sort();
  }

  async create(name: string, deps: Deps): Promise<T> {
    const factory = this.factories.get(name);
    if (!factory) throw new UnknownAdapterError(this.kind, name, this.names());
    return factory(deps);
  }
}
