export type ToolbarLayout = 'floating' | 'left' | 'right'

export function toolbarDropLayout(x: number, y: number, left: number, right: number, top: number): ToolbarLayout {
    if (y < top || y > top + 96) return 'floating'
    if (x <= left + 32) return 'left'
    if (x >= right - 32) return 'right'
    return 'floating'
}
