import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-[70vh] px-6 flex flex-col items-center justify-center gap-4 text-center">
      <p className="font-pixel text-[15px] text-accent">404</p>
      <h1 className="font-pixel text-[32px] tracking-[-0.01em] text-foreground">Page not found</h1>
      <p className="font-rounded text-[17px] text-muted max-w-[420px]">
        That page does not exist, or it moved. Try the search, or start from the overview.
      </p>
      <Link href="/" className="font-rounded text-[16px] text-muted underline underline-offset-[3px] hover:text-foreground">
        Back to the overview
      </Link>
    </main>
  );
}
