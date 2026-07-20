import { Data } from "effect";

export class ResourceNotFound extends Data.TaggedError("ResourceNotFound")<{
  resource: string;
  id: string;
}> {}

export class InjectedFailure extends Data.TaggedError("InjectedFailure")<{
  operation: string;
  step: number;
}> {}

export class InjectedCrash extends Error {
  readonly operation: string;
  readonly step: number;

  constructor(operation: string, step: number) {
    super(`Injected crash at step ${step}: ${operation}`);
    this.name = "InjectedCrash";
    this.operation = operation;
    this.step = step;
  }
}

export type PlaneError = ResourceNotFound | InjectedFailure;
