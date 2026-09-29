/** pi's block π, as in pi.dev/favicon.svg, on a 560 × 560 grid. */
export const PI_MARK =
	"M420 280H280V140H0V0H420V280ZM560 560H420V280H560V560ZM140 560H0V140H140V280H280V420H140V560Z";

export function PiMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 560 560" fill="currentColor" aria-hidden="true" className={className}>
			<path d={PI_MARK} />
		</svg>
	);
}
