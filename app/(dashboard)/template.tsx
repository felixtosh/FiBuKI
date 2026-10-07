export default function DashboardTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fade only. A transform here (slide-in-from-*, and fill-mode-both keeping
  // its last frame) makes this wrapper the containing block of every
  // position: fixed element inside the page, so the detail panels
  // (DetailPanelLayout: fixed top-14 right-0) were placed against the page
  // content instead of the window and sat below the toolbar.
  return <div className="h-full animate-in fade-in-0 duration-200">{children}</div>;
}
