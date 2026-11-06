/*
 * Renzo Chat Core — logika bersama untuk chat widget Social Stream Ninja (SSN).
 *
 * Dipakai oleh: NekoCat, PastelChat, dan widget baru selanjutnya.
 * Widget cukup berisi CSS + <div id="chat-container"> + pengaturan opsional:
 *
 *   <script>
 *     window.RENZO_WIDGET = {
 *       streamers: ["NamaStreamer"],            // dideteksi sebagai Owner
 *       platforms: ["youtube", "tiktok", "twitch"]
 *     };
 *   </script>
 *   <script src="../Core/renzo-chat-core.js"></script>
 *
 * Parameter URL (semua opsional kecuali session):
 *   ?session=KODE          kode session SSN (wajib, tanpa ini widget tidak terhubung)
 *   ?demo=1                putar chat contoh tanpa session (untuk atur posisi di OBS / kirim ke klien)
 *   &limit=8               jumlah pesan maksimal di layar
 *   &autohide=30           pesan hilang setelah N detik (0 = tidak hilang)
 *   &scale=1.2             perbesar/perkecil ukuran (mengubah CSS --k)
 *   &owner=Nama1,Nama2     nama akun yang ditampilkan sebagai Owner
 *   &onlytype=youtube,twitch   hanya tampilkan platform ini
 *   &hidetype=tiktok       sembunyikan platform ini
 *   &showevents=raid,new_follower   tampilkan event tertentu (atau "all"); default: tidak ada
 *   &mindono=1             sembunyikan donasi di bawah nilai USD ini (pakai donoValue dari SSN)
 *   &server / &server2 / &localserver   koneksi WebSocket SSN (opsional)
 *
 * Format data mengikuti dokumentasi SSN: docs/event-reference.html di
 * https://github.com/steveseguin/social_stream
 */
(function () {
    "use strict";

    var CFG = window.RENZO_WIDGET || {};
    var urlParams = new URLSearchParams(window.location.search);

    function listParam(name) {
        if (!urlParams.has(name)) return null;
        return urlParams.get(name).split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    }
    function numParam(name, fallback) {
        if (!urlParams.has(name)) return fallback;
        var n = parseFloat(urlParams.get(name));
        return isNaN(n) ? fallback : n;
    }

    // ---------------- Pengaturan ----------------
    var MAX_MESSAGES = Math.max(1, numParam("limit", 8));
    var AUTO_HIDE = Math.max(0, numParam("autohide", 0));
    var MIN_DONO = numParam("mindono", 0);
    var SHOW_MEMBER_BADGE = CFG.showMemberBadge === true;

    var PLATFORMS = (listParam("onlytype") || (CFG.platforms || ["youtube", "tiktok", "twitch"]).map(function (p) { return p.toLowerCase(); }));
    var HIDDEN_PLATFORMS = listParam("hidetype") || [];
    var SHOW_EVENTS = listParam("showevents") || (CFG.showEvents || []);

    // "@nama" dan "nama" dianggap sama
    var STREAMERS = (CFG.streamers || []).concat(listParam("owner") || []).map(function (s) { return String(s).trim().toLowerCase().replace(/^@+/, ""); });

    if (urlParams.has("scale")) {
        var k = parseFloat(urlParams.get("scale"));
        if (!isNaN(k) && k > 0) document.documentElement.style.setProperty("--k", k);
    }

    // Gaya bawaan untuk elemen tambahan (bisa ditimpa CSS widget)
    var baseStyle = document.createElement("style");
    baseStyle.textContent =
        ".message img.content-img,.message video.content-img{display:block;width:auto;height:auto;max-width:min(100%,calc(180px * var(--k,1)));max-height:calc(120px * var(--k,1));margin:6px 0 0;border-radius:calc(8px * var(--k,1));object-fit:contain}" +
        ".message img.emoji,.message .emoji{width:1.2em;height:1.2em}" +
        (SHOW_MEMBER_BADGE ? "" : ".youtube-member-badge{display:none!important}");
    document.head.appendChild(baseStyle);

    var chatContainer = document.getElementById("chat-container");

    // ---------------- Utilitas ----------------
    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    function lower(s) { return String(s == null ? "" : s).toLowerCase(); }
    function safeUrl(u) {
        u = String(u || "").trim();
        if (/^(https?:)?\/\//i.test(u) || /^data:image\//i.test(u) || /^\.{0,2}\//.test(u)) return u;
        return "";
    }
    function contentMediaHTML(url) {
        url = safeUrl(url);
        if (!url) return "";
        if (/\.(mp4|webm)(\?|#|$)/i.test(url)) {
            return '<video class="content-img" src="' + esc(url) + '" autoplay muted loop playsinline></video>';
        }
        return '<img class="content-img" src="' + esc(url) + '" alt="" onerror="this.remove()">';
    }

    function messageCount() {
        return chatContainer.querySelectorAll(".chat-message:not(.fade-out)").length;
    }
    function removeEl(el) {
        if (!el || el.classList.contains("fade-out")) return;
        el.classList.add("fade-out");
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 600);
    }

    // ---------------- Animasi geser ----------------
    function animateChatShift(newEl) {
        var messages = Array.prototype.slice.call(chatContainer.children);
        var firstRects = messages.map(function (el) { return el.getBoundingClientRect(); });
        chatContainer.appendChild(newEl);
        var lastRects = messages.map(function (el) { return el.getBoundingClientRect(); });
        messages.forEach(function (el, i) {
            var deltaY = firstRects[i].top - lastRects[i].top;
            if (deltaY) {
                requestAnimationFrame(function () {
                    el.style.transform = "translateY(" + deltaY + "px)";
                    el.style.transition = "transform 0s";
                });
            }
        });
        requestAnimationFrame(function () {
            messages.forEach(function (el) {
                el.style.transform = "";
                el.style.transition = "transform 0.4s ease-out";
            });
        });
    }

    // ---------------- Pembuat tampilan ----------------
    // role: regular | member | moderator | owner | donation | new-subscriber | gifted-membership | event
    function buildInner(item) {
        var name = esc(item.username);
        var media = contentMediaHTML(item.contentimg);

        if (item.role === "donation") {
            var text = item.messageHTML ? '<span class="alert-text">' + item.messageHTML + "</span>" : "";
            return '<div class="badge"><span class="truncate-text">' + esc(item.amount || "DONATION") + "</span></div>" +
                '<div class="message"><span class="alert-subtitle">from <span class="truncate-text">' + name + "</span></span>" + text + media + "</div>";
        }
        if (item.role === "new-subscriber") {
            var sub = item.subtitle ? esc(item.subtitle) : "welcome to membership";
            return '<div class="badge"><span class="truncate-text">New Member</span></div>' +
                '<div class="message"><span class="alert-subtitle">' + sub + '</span><span class="alert-text">@' + esc(String(item.username || "").replace(/^@/, "")) + "</span>" + media + "</div>";
        }
        var memberBadge = item.memberBadgeUrl && safeUrl(item.memberBadgeUrl)
            ? '<img class="youtube-member-badge" src="' + esc(item.memberBadgeUrl) + '" alt="">' : "";
        return '<div class="badge"><span class="truncate-text">' + name + "</span></div>" +
            '<div class="message">' + (item.messageHTML || "") + memberBadge + media + "</div>";
    }

    function addChatMessage(item) {
        var chatEl = document.createElement("div");
        chatEl.className = "chat-message " + item.role + (item.extraClass ? " " + item.extraClass : "");
        if (item.id != null) chatEl.setAttribute("data-mid", String(item.id));
        if (item.nativeId) chatEl.setAttribute("data-native-id", String(item.nativeId));
        if (item.userid) chatEl.setAttribute("data-userid", lower(item.userid));
        chatEl.setAttribute("data-name", lower(item.username));
        chatEl.setAttribute("data-type", lower(item.type));
        if (item.streakId) chatEl.setAttribute("data-streak", item.streakId);
        chatEl.innerHTML = buildInner(item);

        animateChatShift(chatEl);

        if (AUTO_HIDE > 0) setTimeout(function () { removeEl(chatEl); }, AUTO_HIDE * 1000);

        // Batasi jumlah pesan (hanya menghitung pesan, bukan spacer, dan bukan yang sedang hilang)
        while (messageCount() > MAX_MESSAGES) {
            removeEl(chatContainer.querySelector(".chat-message:not(.fade-out)"));
        }
        return chatEl;
    }

    // Update kartu gift TikTok yang sama (streak) daripada membuat kartu baru
    function updateStreak(item) {
        if (!item.streakId) return false;
        var el = chatContainer.querySelector('.chat-message[data-streak="' + item.streakId.replace(/"/g, "") + '"]:not(.fade-out)');
        if (!el) return false;
        el.innerHTML = buildInner(item);
        el.classList.remove("streak-bump");
        void el.offsetWidth;
        el.classList.add("streak-bump");
        return true;
    }

    // ---------------- Hapus pesan (moderasi) ----------------
    function handleDelete(del) {
        if (!del) return;
        var type = lower(del.type);
        var nodes = Array.prototype.slice.call(chatContainer.querySelectorAll(".chat-message"));
        nodes.forEach(function (el) {
            if (type && el.getAttribute("data-type") !== type) return;
            var hit = false;
            if (del.id != null && el.getAttribute("data-mid") === String(del.id)) hit = true;
            else if (del.meta && del.meta.messageId && el.getAttribute("data-native-id") === String(del.meta.messageId)) hit = true;
            else if (del.id == null && !(del.meta && del.meta.messageId)) {
                if (del.userid && el.getAttribute("data-userid") === lower(del.userid)) hit = true;
                else if (del.chatname && el.getAttribute("data-name") === lower(del.chatname)) hit = true;
            }
            if (hit) removeEl(el);
        });
    }

    // ---------------- Antrian ----------------
    var messageQueue = [];
    var isProcessing = false;
    function processQueue() {
        if (isProcessing || messageQueue.length === 0) return;
        isProcessing = true;
        var item = messageQueue.shift();
        if (!updateStreak(item)) addChatMessage(item);
        setTimeout(function () { isProcessing = false; processQueue(); }, 120);
    }
    function enqueue(item) {
        messageQueue.push(item);
        processQueue();
    }

    // ---------------- Penerjemah data SSN ----------------
    function badgeStrings(data) {
        var b = data.chatbadges;
        if (!b) return [];
        if (typeof b === "string") b = [b];
        return b.map(function (badge) {
            if (typeof badge === "string") return badge;
            if (badge && typeof badge === "object") {
                return [badge.src, badge.alt, badge.title, badge.name, badge.type, badge.text, badge.rawText]
                    .filter(function (v) { return typeof v === "string"; }).join(" ");
            }
            return "";
        }).filter(Boolean).map(lower);
    }

    function messageHTMLFrom(data) {
        var msg = data.chatmessage || "";
        // textonly=true berarti teks biasa (lihat dokumentasi SSN), jadi harus di-escape
        return data.textonly === true ? esc(msg) : msg;
    }

    function isStreamer(data) {
        if (!STREAMERS.length) return false;
        var noAt = function (s) { return lower(s).replace(/^@+/, ""); };
        return STREAMERS.indexOf(noAt(data.chatname)) !== -1 || (data.username && STREAMERS.indexOf(noAt(data.username)) !== -1);
    }

    function addMessageToOverlay(data) {
        if (!data || typeof data !== "object") return;

        // Hapus pesan oleh moderator
        if (data.delete) { handleDelete(data.delete); return; }
        if (data.event === "user_banned") {
            var m = data.meta || {};
            handleDelete({ type: data.type, userid: m.userId || m.userid, chatname: m.displayName || m.username });
            if (m.username && m.displayName && m.username !== m.displayName) handleDelete({ type: data.type, chatname: m.username });
            return;
        }

        var type = lower(data.type);
        if (PLATFORMS.length && PLATFORMS.indexOf(type) === -1) return;
        if (HIDDEN_PLATFORMS.indexOf(type) !== -1) return;
        if (data.private === true) return;

        var username = data.chatname || "";
        var messageHTML = messageHTMLFrom(data);
        var meta = (data.meta && typeof data.meta === "object") ? data.meta : {};
        var base = {
            username: username,
            messageHTML: messageHTML,
            type: type,
            id: data.id,
            nativeId: meta.messageId,
            userid: data.userid,
            contentimg: data.contentimg,
            subtitle: data.subtitle
        };

        // #1 Donasi / Super Chat / Bits / Gift TikTok
        var hasDono = (typeof data.hasDonation === "string" && data.hasDonation !== "") || (data.donoValue && parseFloat(data.donoValue) > 0);
        if (hasDono) {
            var value = parseFloat(data.donoValue);
            if (MIN_DONO > 0 && !isNaN(value) && value < MIN_DONO) return;
            enqueue(Object.assign(base, {
                role: "donation",
                amount: data.hasDonation || ("$" + data.donoValue),
                streakId: meta.tiktokGiftStreakId || null
            }));
            return;
        }

        // #2 Gift membership
        if (data.gifted === true || data.event === "subscription_gift" || (data.event === true && data.isGift === true)) {
            enqueue(Object.assign(base, { role: "gifted-membership", messageHTML: messageHTML || "Gifted a membership!" }));
            return;
        }

        // #3 Member / subscriber baru
        var isMembershipEvent =
            data.isNewMember ||
            data.event === "new-membership" ||
            data.event === "membership" ||
            data.event === "new_subscriber" ||
            data.event === "resub" ||
            data.event === "subscribe" ||
            data.membershipHeader ||
            (data.isMembership && !data.chatmessage) ||
            (data.isSubscriber && !data.chatmessage);
        if (isMembershipEvent) {
            enqueue(Object.assign(base, { role: "new-subscriber" }));
            return;
        }

        // #4 Event lain (follow, join, like, share, raid, reward, viewer count, dll.)
        if (data.event) {
            var ev = lower(data.event === true ? "system" : data.event);
            var show = SHOW_EVENTS.indexOf("all") !== -1 || SHOW_EVENTS.indexOf(ev) !== -1;
            if (!show || !data.chatmessage) return;
            enqueue(Object.assign(base, { role: "regular", extraClass: "event event-" + ev.replace(/[^a-z0-9_-]/g, "") }));
            return;
        }

        if (!data.chatmessage && !data.contentimg) return;

        // #5 Chat biasa: tentukan peran
        var role = "regular";
        var badges = badgeStrings(data);
        if (isStreamer(data) || data.isOwner === true || data.broadcaster === true ||
            badges.some(function (s) { return s.indexOf("broadcaster") !== -1 || s.indexOf("owner") !== -1; })) {
            role = "owner";
        } else if (data.mod === true || data.moderator === true || data.isModerator === true ||
            badges.some(function (s) { return s.indexOf("moderator") !== -1 || s.indexOf("moderater") !== -1; })) {
            role = "moderator";
        } else if ((data.membership && data.membership !== "") || data.isMembership || data.isSubscriber ||
            badges.some(function (s) {
                return s.indexOf("gifter") !== -1 || s.indexOf("subscriber") !== -1 || s.indexOf("member") !== -1 ||
                    (s.indexOf("fans_badge") !== -1 && s.indexOf("grey") === -1);
            })) {
            role = "member";
        }

        var memberBadgeUrl = null;
        if (role === "member" && Array.isArray(data.chatbadges) && data.chatbadges.length) {
            var first = data.chatbadges[0];
            memberBadgeUrl = typeof first === "string" ? first : (first && first.src) || null;
        }
        enqueue(Object.assign(base, {
            role: role,
            memberBadgeUrl: memberBadgeUrl,
            extraClass: (data.vip ? "vip" : "") + (data.firsttime ? " first-time" : "")
        }));
    }
    window.addMessageToOverlay = addMessageToOverlay;

    // ---------------- Mode demo (&demo=1) ----------------
    // Memutar chat contoh tanpa terhubung ke SSN. Kalau ada &demo=1, mode demo selalu dipakai
    // walaupun ada ?session= (hapus &demo=1 sebelum live).
    var DEMO_STICKER = "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
        '<circle cx="48" cy="48" r="44" fill="#FFD342" stroke="#EBA100" stroke-width="4"/>' +
        '<circle cx="34" cy="40" r="6" fill="#282828"/><circle cx="62" cy="40" r="6" fill="#282828"/>' +
        '<path d="M30 58 Q48 76 66 58" fill="none" stroke="#282828" stroke-width="5" stroke-linecap="round"/>' +
        '<circle cx="24" cy="56" r="6" fill="#FF6A6A" opacity=".7"/><circle cx="72" cy="56" r="6" fill="#FF6A6A" opacity=".7"/></svg>');
    var DEMO_MESSAGES = [
        { chatname: "pixelmochi", chatmessage: "Halo kak, baru nemu channel ini 👋" },
        { chatname: "Raka Senja", chatmessage: "Member 6 bulan hadir! Gas terus kak", membership: "MEMBERSHIP" },
        { chatname: "mod.nadia", chatmessage: "Jangan spam ya teman-teman, santai aja", mod: true },
        { chatname: "Host", chatmessage: "Makasih udah mampir semua, jangan lupa support aku ya", chatbadges: ["https://demo.local/badges/owner.png"] },
        { chatname: "kopi_susu", chatmessage: "Lucu banget stikernya", contentimg: DEMO_STICKER },
        { chatname: "Bima_08", chatmessage: "Semangat buat live hari ini!", hasDonation: "$5.00", donoValue: 5 },
        { chatname: "@Luna Arsy", chatmessage: "", isNewMember: true },
        { chatname: "NamaPenggunaYangSangatPanjangSekaliUntukTes", chatmessage: "Nama panjang harus terpotong rapi, pesan panjang juga harus turun ke baris berikutnya tanpa keluar dari layar." },
        { chatname: "Luna Arsy", chatmessage: "Akhirnya live lagi, kangen 💖", membership: "MEMBERSHIP" },
        { chatname: "mod.nadia", chatmessage: "Ingat ya, tetap sopan di chat", mod: true }
    ];
    function startDemo() {
        var types = ["youtube", "tiktok", "twitch"].filter(function (t) {
            return (!PLATFORMS.length || PLATFORMS.indexOf(t) !== -1) && HIDDEN_PLATFORMS.indexOf(t) === -1;
        });
        if (!types.length) types = PLATFORMS.length ? PLATFORMS.slice() : ["youtube"];
        var i = 0;
        function next() {
            var m = Object.assign({}, DEMO_MESSAGES[i % DEMO_MESSAGES.length]);
            m.type = types[i % types.length];
            m.id = "demo-" + i;
            i += 1;
            addMessageToOverlay(m);
        }
        for (var n = 0; n < 3; n++) setTimeout(next, n * 600);
        setTimeout(function () { setInterval(next, 2500); }, 1800);
    }
    if (urlParams.has("demo") && urlParams.get("demo") !== "0" && urlParams.get("demo") !== "false") {
        startDemo();
        return;
    }

    // ---------------- Koneksi ke SSN ----------------
    if (!urlParams.has("session") || !urlParams.get("session")) {
        console.warn("[Renzo Chat] Tambahkan ?session=KODE_SESSION di URL. Widget tidak terhubung tanpa kode session.");
        return;
    }
    var roomID = urlParams.get("session");
    var password = urlParams.get("password") || "false";

    var iframe = document.createElement("iframe");
    iframe.src = "https://vdo.socialstream.ninja/?ln&salt=vdo.ninja&password=" + encodeURIComponent(password) +
        "&push&label=dock&vd=0&ad=0&novideo&noaudio&autostart&cleanoutput&room=" + encodeURIComponent(roomID);
    iframe.style.cssText = "width:0;height:0;border:0;position:absolute;top:-10px;left:-10px;";
    document.body.appendChild(iframe);
    window.addEventListener("message", function (e) {
        if (e.source != iframe.contentWindow) return;
        if (e.data && e.data.dataReceived && e.data.dataReceived.overlayNinja) {
            addMessageToOverlay(e.data.dataReceived.overlayNinja);
        }
    });

    var conCon = 1;
    var socketserver = false;
    var serverURL = urlParams.has("localserver") ? "ws://127.0.0.1:3000" : "wss://io.socialstream.ninja";
    function setupSocket() {
        socketserver.onclose = function () {
            setTimeout(function () {
                conCon += 1;
                socketserver = new WebSocket(serverURL);
                setupSocket();
            }, 100 * conCon);
        };
        socketserver.onopen = function () {
            conCon = 1;
            socketserver.send(JSON.stringify({ join: roomID, out: 3, in: 4 }));
        };
        socketserver.addEventListener("message", function (event) {
            if (!event.data) return;
            try {
                var data = JSON.parse(event.data);
                if (data) addMessageToOverlay(data);
            } catch (error) {
                console.error("Error processing WebSocket message:", error, "Data:", event.data);
            }
        });
    }
    if (urlParams.has("server") || urlParams.has("server2")) {
        serverURL = urlParams.get("server") || urlParams.get("server2") || serverURL;
        socketserver = new WebSocket(serverURL);
        setupSocket();
    }
})();
