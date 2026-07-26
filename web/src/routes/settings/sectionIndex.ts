/**
 * The section the reader is on, given each section's offset inside the scroll
 * container. The last section whose heading has passed under the sticky index
 * wins, so the highlight changes exactly when a heading docks.
 */
export function activeSectionId(
    sections: ReadonlyArray<{ id: string; offsetTop: number }>,
    scrollTop: number,
    stickyHeight: number
): string | null {
    if (sections.length === 0) return null
    const line = scrollTop + stickyHeight + 1
    let active = sections[0].id
    for (const section of sections) {
        if (section.offsetTop <= line) active = section.id
    }
    return active
}
