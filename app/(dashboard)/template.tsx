export default function DashboardTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  // Opacity only (animate-page-in, globals.css). A transform here, even the
  // one tailwindcss-animate's animate-in always animates, makes this wrapper
  // the containing block of every position: fixed element inside the page,
  // so the detail panels (DetailPanelLayout: fixed top-14 right-0) were
  // placed against the page content instead of the window and sat below the
  // toolbar, or jumped into place when the animation ended.
  return <div className="h-full animate-page-in">{children}</div>;
}
