export function isCurrentGeneration(
  activeGenerationId: string | undefined,
  eventGenerationId: string,
): boolean {
  return (
    activeGenerationId !== undefined &&
    activeGenerationId === eventGenerationId
  )
}
