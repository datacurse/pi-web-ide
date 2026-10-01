export type Point = { x: number; y: number };
export type Mark = { id: number; kind: "area" | "arrow" | "pen"; color: string; width: number; points: Point[] };
export type ImageWorkspace = { marks: Mark[]; nextId: number; exportedSrc?: string; exportedCount?: number };

export function markLabel(mark: Mark): string {
	return `${mark.kind === "area" ? "Area" : mark.kind === "arrow" ? "Arrow" : "Pen"} ${mark.id}`;
}

export function moveMark(mark: Mark, dx: number, dy: number): Mark {
	return { ...mark, points: mark.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
}

export function markSvg(mark: Mark): string {
	const first = mark.points[0];
	const last = mark.points[mark.points.length - 1];
	if (!first || !last) return "";
	const style = `fill="none" stroke="${mark.color}" stroke-width="${mark.width}" stroke-linecap="round" stroke-linejoin="round"`;
	let shape: string;
	if (mark.kind === "area") {
		shape = `<rect x="${Math.min(first.x, last.x)}" y="${Math.min(first.y, last.y)}" width="${Math.abs(last.x - first.x)}" height="${Math.abs(last.y - first.y)}" ${style}/>`;
	} else {
		shape = `<polyline points="${mark.points.map((p) => `${p.x},${p.y}`).join(" ")}" ${style}/>`;
		if (mark.kind === "arrow") {
			const angle = Math.atan2(last.y - first.y, last.x - first.x);
			const length = mark.width * 5;
			const wing = (offset: number) => `${last.x - length * Math.cos(angle + offset)},${last.y - length * Math.sin(angle + offset)}`;
			shape += `<polyline points="${wing(-0.5)} ${last.x},${last.y} ${wing(0.5)}" ${style}/>`;
		}
	}
	return `${shape}<text x="${first.x}" y="${Math.max(mark.width * 6, first.y - mark.width * 2)}" fill="${mark.color}" stroke="black" stroke-width="${mark.width / 2}" paint-order="stroke" font-family="sans-serif" font-size="${mark.width * 6}">${markLabel(mark)}</text>`;
}

export function annotationSvg(marks: Mark[], width: number, height: number): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${marks.map(markSvg).join("")}</svg>`;
}

export function annotationReference(mark: Mark, width: number, height: number): string {
	const xs = mark.points.map((p) => p.x / width * 100);
	const ys = mark.points.map((p) => p.y / height * 100);
	const tip = mark.kind === "arrow" ? `; tip ${xs[xs.length - 1].toFixed(1)}%,${ys[ys.length - 1].toFixed(1)}%` : "";
	return `${markLabel(mark)} (${mark.color}; bounds ${Math.min(...xs).toFixed(1)}%,${Math.min(...ys).toFixed(1)}%–${Math.max(...xs).toFixed(1)}%,${Math.max(...ys).toFixed(1)}%${tip})`;
}
