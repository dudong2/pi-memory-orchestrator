export function parseJson<T = unknown>(text: string, description: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`invalid JSON in ${description}`, { cause: error });
  }
}
