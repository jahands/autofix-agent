type PascalCase<S extends string> = S extends `${infer P1}_${infer P2}`
	? `${Capitalize<Lowercase<P1>>}${PascalCase<Capitalize<Lowercase<P2>>>}`
	: Capitalize<S>

/**
 * Utility type to convert a string like "detect_issues" to "handleDetectIssues"
 */
type ActionToHandlerName<A extends string> = `handle${PascalCase<A>}`

/**
 * Decorator function to ensure the decorated class has handler methods for the given action
 */
export function EnsureAgentActions<const TActionStrings extends readonly string[]>(
	_actionsToHandle: TActionStrings
) {
	return function <
		Ctor extends new (...args: any[]) => {
			[K in TActionStrings[number] as ActionToHandlerName<K>]: () => Promise<void>
		} & { [key: string]: any },
	>(value: Ctor, context: ClassDecoratorContext): Ctor | void {
		if (context.kind !== 'class') {
			throw new Error('EnsureAgentActions must be used as a class decorator.')
		}
		// We don't modify the class at all - only used for type checks.
		return value
	}
}
