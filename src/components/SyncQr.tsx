import { useEffect, useState } from "react";

/** The pairing link as an inline SVG QR: dark modules on white, 4-module quiet zone. */
export function SyncQr({ value }: { value: string }) {
  const [grid, setGrid] = useState<boolean[][] | null>(null);
  useEffect(() => {
    let alive = true;
    void import("uqr").then(({ encode }) => {
      if (alive) {
        setGrid(encode(value, { ecc: "M", border: 4 }).data);
      }
    });
    return () => {
      alive = false;
    };
  }, [value]);
  if (grid === null) {
    return <div className="sync-qr sync-qr-loading" aria-hidden="true" />;
  }
  const size = grid.length;
  let path = "";
  grid.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) {
        path += `M${x} ${y}h1v1h-1z`;
      }
    });
  });
  return (
    <svg
      className="sync-qr"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Pairing QR code"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
