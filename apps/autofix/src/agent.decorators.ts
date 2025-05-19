// No direct import from AutofixAgent needed here.

// Utility type to convert snake_case or simple strings to PascalCase
type PascalCase<S extends string> = S extends `${infer P1}_${infer P2}`
	? `${Capitalize<Lowercase<P1>>}${PascalCase<Capitalize<Lowercase<P2>>>}`
	: Capitalize<S>

// Utility type to derive the expected handler method name from a generic action name string
export type ActionToHandlerName<A extends string> = `handle${PascalCase<A>}`

// Decorator Function: Generic over any array of action strings.
// It ensures the decorated class has appropriately named handler methods for these strings.
export function EnsureAgentActions<const TActionStrings extends ReadonlyArray<string>>(
	actionsToHandle: TActionStrings
) {
	return function <
		Ctor extends new (...args: any[]) => {
			[K in TActionStrings[number] as ActionToHandlerName<K>]: () => Promise<void>
		} & { [key: string]: any }, // Index signature for dynamic access, kept for flexibility
	>(value: Ctor, context: ClassDecoratorContext): Ctor | void {
		if (context.kind !== 'class') {
			throw new Error('EnsureAgentActions must be used as a class decorator.')
		}
		// This decorator ONLY performs compile-time type checking for handler existence and signature.
		return value
	}
}

// AGENT_SEQUENCE_END, NextActionOutcome, HandledAgentActions (specific to an agent's action set)
// are no longer defined or exported by this generic decorator module.
// They should be defined by the consumer (e.g., AutofixAgent.ts) if needed for its own logic.
