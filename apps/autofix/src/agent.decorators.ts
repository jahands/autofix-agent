import type { AgentAction } from './AutofixAgent' // Adjust path as needed

// Define which actions are excluded from needing explicit handlers defined by the decorator
type ExcludedActions = 'idle'

// Define the actions that are expected to have handlers
export type HandledAgentActions = Exclude<AgentAction, ExcludedActions>

// Utility type to convert snake_case or simple strings to PascalCase
// More robust PascalCase conversion might be needed for complex strings
type PascalCase<S extends string> = S extends `${infer P1}_${infer P2}`
	? `${Capitalize<Lowercase<P1>>}${PascalCase<Capitalize<Lowercase<P2>>>}`
	: Capitalize<S>

// Utility type to derive the expected handler method name from an action name
// e.g., 'initialize_container' -> 'handleInitializeContainer'
export type ActionToHandlerName<A extends HandledAgentActions> = `handle${PascalCase<A>}`

// The Decorator Function
export function EnsureActionHandlers<const TActions extends readonly HandledAgentActions[]>(
	actions: TActions
) {
	// `const` helps infer TActions as a literal tuple type
	return function <
		// TargetClass is the constructor of the decorated class
		TargetClass extends new (...args: any[]) => {
			// This mapped type enforces that for each action name in the TActions tuple,
			// the class instance must have a method with the derived handler name,
			// and that method must match the expected signature: () => Promise<void>.
			[K in TActions[number] as ActionToHandlerName<K>]: () => Promise<void>
		},
	>(target: TargetClass): TargetClass | void {
		// This decorator primarily serves for compile-time type checking.
		// Runtime checks could be added here if desired, for example:
		/*
        if (process.env.NODE_ENV === 'development') { // Example runtime check
            const prototype = target.prototype;
            for (const action of actions) {
                const handlerName = `handle${pascalCase(action)}` as ActionToHandlerName<typeof action>;
                // A robust pascalCase function would be needed here for runtime conversion
                if (typeof prototype[handlerName] !== 'function') {
                    console.warn(
                        `[EnsureActionHandlers] Missing handler method '${handlerName}' for action '${action}' in class '${target.name}'.`
                    );
                }
            }
        }
        */
		return target // Standard decorator practice is to return the target or a new constructor
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
