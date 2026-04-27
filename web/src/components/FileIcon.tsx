import { useMemo } from 'react'
import { getFileIconSvg } from '@/lib/material-file-icons'

export function FileIcon(props: { fileName: string; size?: number }) {
    const size = props.size ?? 20
    const svg = useMemo(() => getFileIconSvg(props.fileName), [props.fileName])

    return (
        <span
            aria-hidden="true"
            className="inline-flex shrink-0 items-center justify-center"
            style={{ width: size, height: size }}
            dangerouslySetInnerHTML={{ __html: svg.replace(/<svg /, `<svg width="${size}" height="${size}" `) }}
        />
    )
}
