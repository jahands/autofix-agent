// import type { AgentAction } from './AutofixAgent'; // REMOVED
// No longer importing AgentState or logger for this simplified version

// Removed ExcludedActions and specific HandledAgentActions definition
// export type HandledAgentActions = Exclude<AgentAction, ExcludedActions>;

// Utility type to convert snake_case or simple strings to PascalCase
// This utility is now generic over any string.
type PascalCase<S extends string> = S extends `${infer P1}_${infer P2}`
	? `${Capitalize<Lowercase<P1>>}${PascalCase<Capitalize<Lowercase<P2>>>}`
	: Capitalize<S>

// Utility type to derive the expected handler method name from an action name (string)
export type ActionToHandlerName<A extends string> = `handle${PascalCase<A>}`

// Simplified Decorator Function - now generic over action strings
export function EnsureAgentActions<
	const TActionStrings extends ReadonlyArray<string>, // Accepts any array of strings
>(actionsToHandle: TActionStrings) {
	return function <
		// Ctor is constrained to have handlers for the specific strings passed in TActionStrings
		Ctor extends new (...args: any[]) => {
			[K in TActionStrings[number] as ActionToHandlerName<K>]: () => Promise<void>
		} & { [key: string]: any },
	>(value: Ctor, context: ClassDecoratorContext): Ctor | void {
		if (context.kind !== 'class') {
			throw new Error('EnsureAgentActions must be used as a class decorator.')
		}

		return value
	}
}

// --- Example of a more robust PascalCase utility for runtime (if needed for runtime checks) ---
// Not strictly required for the type-checking aspect if action names are simple snake_case.
/*
function pascalCase(str: string): string {
    return str
        .split(/[_-]/) // Split by underscore or hyphen
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');
}
*/
