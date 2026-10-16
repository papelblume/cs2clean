// The script that runs inside Steam's "Friends List" page (reached over the debug port, see steam-ui.ts).
// It reads what that window shows: our own header and one row per friend, with the status text Steam builds
// from the game's rich presence ("Competitive - Office [ 5 : 0 ]"). Steam's class names for most parts are
// generated hashes that change with updates, so it only uses the readable ones (.friend, .friendGroup,
// .groupName, .labelHolder, .AvatarAndUser) and the position of things inside a row.
//
// A row is  .friend > .labelHolder > [ div(name, ContextMenuButton), div(status) ]
// The name div holds the shown name; when a nickname is set the real persona name follows in a <span> "(...)".
// Our own header is  .AvatarAndUser .labelHolder > [ div(name), div(persona state, then the game's status) ].
//
// Kept as plain JavaScript in a string so it reaches the page exactly as written (no compiler helpers).

export const COLLECT_FRIENDS_JS = String.raw`(() => {
  const text = (el) => (el && el.textContent ? el.textContent.trim() : "");
  const kids = (el) => (el ? Array.from(el.children) : []);
  const label = document.querySelector(".AvatarAndUser .labelHolder");
  const own = label ? { parts: kids(label.children[1]).map(text) } : null;
  const rows = Array.from(document.querySelectorAll(".friend")).map((f) => {
    const lh = f.querySelector(".labelHolder");
    const nameEl = lh && lh.children[0] ? lh.children[0].children[0] : null;
    const span = nameEl ? nameEl.querySelector("span") : null;
    const grp = f.closest(".friendGroup");
    const gname = grp ? grp.querySelector(".groupName") : null;
    return {
      group: gname ? Array.from(gname.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim() : null,
      nickname: nameEl && nameEl.firstChild ? nameEl.firstChild.textContent.trim() : "",
      persona: text(span).replace(/^\(|\)$/g, ""),
      status: lh ? text(lh.children[1]) : "",
    };
  });
  return { own: own, rows: rows };
})()`;
