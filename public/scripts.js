const rulesets = ['osu', 'taiko', 'catch', 'mania'];
let selected_ruleset = parseInt(localStorage.getItem('selected_ruleset') || '0', 10);
let user_id = localStorage.getItem('user_id');

function finish_authentication() {
  const id = document.querySelector('#authenticated_osu_id').value;
  if (id == '{{ user_id }}') return;

  user_id = parseInt(id, 10);
  localStorage.setItem('user_id', user_id);
  update_header_profile();
}
finish_authentication();

function update_selected_ruleset(name) {
  if (name == 'std') name = 'osu';
  if (name == 'fruits') name = 'catch';
  if (!rulesets.includes(name)) name = 'osu';

  localStorage.setItem('selected_ruleset', rulesets.indexOf(name));
  selected_ruleset = rulesets.indexOf(name);

  document.querySelector('#toggle-rulesets-dropdown-btn img').src = `/images/mode-${rulesets[selected_ruleset]}.png`;
}

function update_header_highlights() {
  const header_links = document.querySelectorAll('header a');
  for (const link of header_links) {
    if (location.pathname.includes(link.pathname)) {
      link.classList.add('opacity-100');
    } else {
      link.classList.remove('opacity-100');
    }
  }
}

function update_header_profile() {
  const a = document.querySelector('.login-btn');
  if (user_id) {
    a.href = `/u/${user_id}/${rulesets[selected_ruleset]}/`;
    a.querySelector('img').src = `https://s.ppy.sh/a/${user_id}`;
  } else {
    a.href = '/osu_login';
    a.querySelector('img').src = `/images/login.png`;
  }
}


// Returns the color of a given star rating, matching osu!web's color scheme.
function stars_to_color(sr) {
  if (sr <= 0.1) {
    return '#4290FB';
  } else if (sr >= 9) {
    return '#000000';
  }

  const star_levels = [0.1, 1.25, 2, 2.5, 3.3, 4.2, 4.9, 5.8, 6.7, 7.7, 9];
  const star_colors = ['#4290FB', '#4FC0FF', '#4FFFD5', '#7CFF4F', '#F6F05C', '#FF8068', '#FF4E6F', '#C645B8', '#6563DE', '#18158E', '#000000'];
  for (const i in star_levels) {
    if (!star_levels.hasOwnProperty(i)) continue;
    if (star_levels[i] > sr && star_levels[i-1] < sr) {
      const lower = star_levels[i - 1];
      const upper = star_levels[i];
      const ratio = (sr - lower) / (upper - lower);
      const r = parseInt(star_colors[i-1].substr(1, 2), 16) * (1 - ratio) + parseInt(star_colors[i].substr(1, 2), 16) * ratio;
      const g = parseInt(star_colors[i-1].substr(3, 2), 16) * (1 - ratio) + parseInt(star_colors[i].substr(3, 2), 16) * ratio;
      const b = parseInt(star_colors[i-1].substr(5, 2), 16) * (1 - ratio) + parseInt(star_colors[i].substr(5, 2), 16) * ratio;
      return '#' + Math.round(r).toString(16).padStart(2, '0') + Math.round(g).toString(16).padStart(2, '0') + Math.round(b).toString(16).padStart(2, '0');
    }
  }
}


document.addEventListener('click', (event) => {
  const open_ruleset_dropdown_btn = document.querySelector('#toggle-rulesets-dropdown-btn');
  const ruleset_dropdown = document.querySelector('#rulesets-dropdown');
  if (open_ruleset_dropdown_btn.contains(event.target)) {
    ruleset_dropdown.classList.toggle('hidden');
  } else {
    ruleset_dropdown.classList.add('hidden');
  }
});

document.querySelectorAll('.choose-ruleset').forEach((btn) => {
  btn.addEventListener('click', function(event) {
    event.preventDefault();
    update_selected_ruleset(rulesets[parseInt(this.dataset.ruleset, 10)]);

    let url = location.pathname;
    for (const ruleset of rulesets) {
      url = url.replaceAll(/\/(osu|taiko|catch|mania)/g, '/' + rulesets[selected_ruleset]);
    }
    window.history.pushState({}, '', url);
    route(url);
  });
});


function click_listener(evt) {
  if (this.pathname == '/osu_login') {
    document.cookie = 'redirect=' + location.pathname.split('/')[1];
    return true;
  }

  // Intercept clicks that don't lead to an external domain
  if (this.host == location.host && this.target != '_blank') {
    evt.preventDefault();

    window.history.pushState({}, '', this.href);
    route(this.href);
  }
};

window.addEventListener('popstate', function(event) {
  route(event.target.location.href);
});


async function get(url) {
  const res = await fetch(url, {
    credentials: 'same-origin',
  });

  if (!user_id && res.headers.has('X-Osu-ID')) {
    user_id = parseInt(res.headers.get('X-Osu-ID'), 10);
    localStorage.setItem('user_id', user_id);
    update_header_profile();
  }

  const json = await res.json();
  if (json.error) {
    document.querySelector('main').innerHTML = json.error;
    throw json.error;
  }

  return json;
}


function render_pagination(node, page_num, max_pages, url_formatter) {
  const MAX_PAGINATED_PAGES = Math.min(max_pages, 9);
  let pagination_min = page_num;
  let pagination_max = page_num;
  let nb_paginated_pages = 1;
  const pages = [];

  while (nb_paginated_pages < MAX_PAGINATED_PAGES) {
    if (pagination_min > 1) {
      pagination_min--;
      nb_paginated_pages++;
    }
    if (pagination_max < max_pages) {
      pagination_max++;
      nb_paginated_pages++;
    }
  }
  for (let i = pagination_min; i <= pagination_max; i++) {
    pages.push({
      number: i,
      is_current: i == page_num,
    });
  }

  const previous = Math.max(page_num - 1, 1);
  const next = Math.min(page_num + 1, max_pages);
  node.innerHTML = `
  <div class="flex justify-between m-5">
    <a class="text-xl text-zinc-400 hover:text-zinc-50" href="${url_formatter(previous)}"><span class="text-2xl text-orange-600 mr-2">‹</span>Previous</a>
    <div class="number-nav leading-10"></div>
    <a class="text-xl text-zinc-400 hover:text-zinc-50" href="${url_formatter(next)}">Next<span class="text-2xl text-orange-600 ml-2">›</span></a>
  </div>`;
  const numbers_div = node.querySelector('.number-nav');
  for (const page of pages) {
    numbers_div.innerHTML += `
      <a class="text-xl px-3 py-2 border-transparent border-2 ${page.is_current ? 'text-zinc-50 border-b-orange-600' : 'text-zinc-400 hover:text-zinc-50 hover:border-b-orange-400'}"
      href="${url_formatter(page.number)}">${page.number}</a>`;
  }
}

function render_lobby(lobby) {
  const lobby_div = document.createElement('div');
  lobby_div.classList.add('lobby');

  let stars = 'Dynamic';
  if (lobby.fixed_stars) {
    stars = `${lobby.min_stars.toFixed(1)}-${lobby.max_stars.toFixed(1)}*`;
  }

  const color = stars_to_color(lobby.map ? lobby.map.stars : 0);
  lobby_div.className = 'flex flex-1 m-2 rounded-md';
  lobby_div.style = `border: solid ${color} 2px`;
  lobby_div.innerHTML += `
    <div class="lobby-info min-w-[25rem] flex-1 p-2">
      <div class="lobby-title font-bold"></div>
      <div>${stars} · ${lobby.nb_players}/16 players</div>
      <div class="lobby-creator">Created by <a href="/u/${lobby.creator_id}"><img class="h-5 text-bottom rounded-full inline" src="https://s.ppy.sh/a/${lobby.creator_id}" alt="Lobby creator"> ${lobby.creator_name}</a></div>
    </div>
    <div class="lobby-links flex flex-col justify-evenly" style="background-color:${color}">
      <div class="group relative text-center"><a class="!text-white text-2xl p-1.5 pl-2" href="osu://mp/${lobby.bancho_id}"><i class="fa-solid fa-xs fa-arrow-up-right-from-square"></i></a><span class="tooltip top-[-1.3rem]">Join (cutting edge only)</span></div>
      <div class="group relative text-center"><a class="!text-white text-2xl p-1.5 pl-2" href="/get-invite/${lobby.bancho_id}" target="_blank"><i class="fa-solid fa-xs fa-envelope"></i></a><span class="tooltip top-[-0.1rem]">Get invite</span></div>
    </div>`;
  lobby_div.querySelector('.lobby-title').innerText = lobby.name;
  return lobby_div;
}

async function render_faq() {
  document.title = 'FAQ - o!RL';
  const template = document.querySelector('#FAQ-template').content.cloneNode(true);
  const ranked_template = document.querySelector('#ranked-command-list-template').content.cloneNode(true);
  const unranked_template = document.querySelector('#unranked-command-list-template').content.cloneNode(true);
  template.querySelector('.ranked').appendChild(ranked_template);
  template.querySelector('.unranked').appendChild(unranked_template);
  document.querySelector('main').appendChild(template);
}

async function render_lobbies() {
  document.title = 'Lobbies - o!RL';
  const json = await get('/api/lobbies/');
  const template = document.querySelector('#lobbies-template').content.cloneNode(true);
  const list = template.querySelector('.lobby-list');

  for (const lobby of json) {
    if (lobby.creator_id == user_id) {
      // User already created a lobby: hide the "Create lobby" button
      template.querySelector('.lobby-creation-banner').hidden = true;
    }
    list.appendChild(render_lobby(lobby));
  }

  document.querySelector('main').appendChild(template);
  document.querySelector('main .go-to-create-lobby').addEventListener('click', (evt) => {
    evt.preventDefault();
    if (user_id == null) {
      document.cookie = 'redirect=create-lobby';
      document.location = '/osu_login';
    } else {
      window.history.pushState({}, '', '/create-lobby/');
      route('/create-lobby/');
    }
  });
}


function fancy_elo(elo) {
  if (elo == '???') {
    return '???';
  } else {
    return Math.round(elo);
  }
}

async function render_leaderboard(ruleset, page_num) {
  document.title = 'Leaderboard - o!RL';
  const json = await get(`/api/leaderboard/${ruleset}/${page_num}`);

  const template = document.querySelector('#leaderboard-template').content.cloneNode(true);
  const lboard = template.querySelector('.leaderboard tbody');
  for (const player of json.players) {
    lboard.innerHTML += `
      <tr class="inline-flex justify-between">
        <td class="border border-transparent border-r-zinc-700 p-1.5 pr-3 w-10 text-right">${player.ranking}</td>
        <td class="pl-3 p-1.5 ${player.ranking == 1 ? 'the-one': ''}"><a href="/u/${player.user_id}/">${player.username}</a></td>
        <td class="p-1.5 ml-auto">${fancy_elo(player.elo)}</td>
        <td class="p-1.5 text-orange-600">ELO</td>
      </tr>`;
  }

  const pagi_div = template.querySelector('.pagination');
  render_pagination(pagi_div, json.page, json.max_pages, (num) => `/leaderboard/${ruleset}/page-${num}/`);

  document.querySelector('main').appendChild(template);
}


async function render_user(user_id, page_num) {
  const json = await get('/api/user/' + user_id);
  const user_info = json.ranks[selected_ruleset];
  document.title = `${json.username} - o!RL`;

  const division_to_class = {
    'Unranked': 'unranked',
    'Cardboard': 'cardboard',
    'Wood': 'wood',
    'Wood+': 'wood',
    'Bronze': 'bronze',
    'Bronze+': 'bronze',
    'Silver': 'silver',
    'Silver+': 'silver',
    'Gold': 'gold',
    'Gold+': 'gold',
    'Platinum': 'platinum',
    'Platinum+': 'platinum',
    'Diamond': 'diamond',
    'Diamond+': 'diamond',
    'Rhythm Incarnate': 'rhythm-incarnate',
    'The One': 'the-one',
  };

  const ruleset = rulesets[selected_ruleset];
  const template = document.querySelector('#user-template').content.cloneNode(true);
  template.querySelector('.heading-left img').src = `https://s.ppy.sh/a/${json.user_id}`;
  template.querySelector('.heading-right h1').innerText = json.username;
  template.querySelector('.heading-right h1').classList.add(division_to_class[user_info.text]);
  template.querySelector('.heading-right .subheading').href = `https://osu.ppy.sh/users/${json.user_id}`;
  template.querySelectorAll('.user-modes a').forEach((div) => {
    div.href = `/u/${json.user_id}/${div.querySelector('img').getAttribute('ruleset')}`;
  });

  const blocks = template.querySelectorAll('.user-focus-block');
  if (user_info.nb_scores >= 5) {
    blocks[0].innerHTML = `<span class="text-3xl ${division_to_class[user_info.text]}">${user_info.text}</span><span class="text-xl p-1">Rank #${user_info.rank_nb}</span>`;
    blocks[1].innerHTML = `<span class="text-orange-600 text-3xl">${user_info.nb_scores}</span><span class="text-xl p-1">Games Played</span>`;
    blocks[2].innerHTML = `<span class="text-orange-600 text-3xl">${fancy_elo(user_info.elo)}</span><span class="text-xl p-1">Elo</span>`;
  } else {
    blocks[0].innerHTML = `<span class="text-3xl">Unranked</span><span class="text-xl p-1">Rank #???</span>`;
    blocks[1].innerHTML = `<span class="text-orange-600 text-3xl">${user_info.nb_scores}</span><span class="text-xl p-1">Games Played</span>`;
    blocks[2].remove();
  }
  document.querySelector('main').appendChild(template);

  const matches_json = await get(`/api/user/${user_id}/${ruleset}/matches/${page_num}`);
  const tbody = document.querySelector('.match-history tbody');
  const osu_rulesets = ['osu', 'taiko', 'fruits', 'mania'];
  for (const match of matches_json.matches) {
    const row = document.createElement('tr');
    row.classList.add('inline-flex', 'justify-between');
    row.innerHTML = `
      <td class="map grow w-40 p-1.5 text-center border border-transparent border-t-zinc-700">
        <a href="https://osu.ppy.sh/beatmapsets/${match.map.set_id}#${osu_rulesets[selected_ruleset]}/${match.map.id}"></a>
      </td>
      <td class="w-40 p-1.5 text-center border border-transparent border-t-zinc-700 ${match.won ? 'text-green-600' : 'text-red-600'}">
        ${match.won ? 'WON' : 'LOST'}
      </td>
      <td class="w-40 p-1.5 text-center border border-transparent border-t-zinc-700" data-tms="${match.tms}">${match.time}</td>`;
    row.querySelector('.map a').innerText = match.map.name;
    tbody.appendChild(row);
  }

  const pagi_div = document.querySelector('.pagination');
  render_pagination(pagi_div, matches_json.page, matches_json.max_pages, (num) => `/u/${user_id}/${ruleset}/page-${num}/`);
}


async function route(new_url) {
  console.info('Loading ' + new_url);
  update_header_highlights();
  update_header_profile();
  update_selected_ruleset(rulesets[selected_ruleset]);

  if (new_url == '/osu_login') {
    document.location = '/osu_login';
    return;
  }

  let m;
  if (m = new_url.match(/\/create-lobby\//)) {
    document.title = 'New lobby - o!RL';
    document.querySelector('main').innerHTML = '';
    const template = document.querySelector('#lobby-creation-template').content.cloneNode(true);
    console.log(template);
    template.querySelector('h1').innerText = `New ${rulesets[selected_ruleset]} lobby`;
    document.querySelector('main').appendChild(template);

    document.querySelector('.lobby-settings').addEventListener('change', (evt) => {
      if (evt.target.name == 'lobby-type') {
        const custom_settings = document.querySelector('main .custom-settings');
        custom_settings.hidden = !custom_settings.hidden;
      }
    });

    document.querySelector('main input[name="auto-star-rating"]').addEventListener('click', () => {
      const range = document.querySelector('main .star-rating-range');
      range.hidden = !range.hidden;
    });

    document.querySelector('main .go-back-btn').addEventListener('click', (evt) => {
      evt.preventDefault();
      document.querySelector('.lobby-creation-error').hidden = true;
      document.querySelector('.lobby-settings').hidden = false;
    });

    document.querySelectorAll('main .create-lobby-btn').forEach((btn) => btn.addEventListener('click', async (evt) => {
      evt.preventDefault();
      document.querySelector('main .lobby-settings').hidden = true;
      document.querySelector('main .lobby-creation-need-ref').hidden = true;
      document.querySelector('main .lobby-creation-spinner').hidden = false;

      const lobby_type = document.querySelector('input[name="lobby-type"]:checked').value;
      try {
        const lobby_settings = {
          type: lobby_type,
          ruleset: selected_ruleset,
          star_rating: document.querySelector('main input[name="auto-star-rating"]').checked ? 'auto' : 'fixed',
          min_stars: parseFloat(document.querySelector('main input[name="min-stars"]').value),
          max_stars: parseFloat(document.querySelector('main input[name="max-stars"]').value),
          title: document.querySelector('input[name="title"]').value,
        };
        const collection_input = document.querySelector('main input[name="collection-url"]');
        if (collection_input.value) {
          lobby_settings.collection_id = parseInt(collection_input.value.split('/').reverse()[0], 10);
        }
        const match_input = document.querySelector('main input[name="tournament-url"]');
        if (match_input.value) {
          lobby_settings.match_id = parseInt(match_input.value.split('/').reverse()[0], 10);
        }

        const res = await fetch('/api/create-lobby/', {
          body: JSON.stringify(lobby_settings),
          credentials: 'same-origin',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          method: 'POST',
        });
        const json_res = await res.json();
        if (json_res.error) {
          if (json_res.details == 'Cannot create any more matches.') {
            document.querySelector('.lobby-creation-spinner').hidden = true;
            document.querySelector('.lobby-creation-need-ref').hidden = false;
            return;
          }

          throw new Error(json_res.details || json_res.error);
        }

        document.querySelector('.lobby-creation-spinner').hidden = true;
        document.querySelector('.lobby-creation-success .lobby').outerHTML = render_lobby(json_res.lobby).outerHTML;

        const info_template = document.querySelector(lobby_type == 'ranked' ? '#ranked-command-list-template' : '#unranked-command-list-template').content.cloneNode(true);
        document.querySelector('.lobby-creation-success .info').appendChild(info_template);
        document.querySelector('.lobby-creation-success').hidden = false;
      } catch (err) {
        document.querySelector('.lobby-creation-error .error-msg').innerText = err.message;
        document.querySelector('.lobby-creation-spinner').hidden = true;
        document.querySelector('.lobby-creation-error').hidden = false;
      }
    }));
  } else if (m = new_url.match(/\/faq\//)) {
    document.querySelector('main').innerHTML = '';
    await render_faq();
  } else if (m = new_url.match(/\/lobbies\//)) {
    document.querySelector('main').innerHTML = '';
    await render_lobbies();
  } else if (m = new_url.match(/\/leaderboard\/(\w+)\/(page-(\d+)\/)?/)) {
    const ruleset = m[1];
    update_selected_ruleset(ruleset);

    const page_num = m[3] || 1;
    document.querySelector('main').innerHTML = '';
    await render_leaderboard(ruleset, page_num);
  } else if (m = new_url.match(/\/u\/(\d+)\/(\w+)\/page-(\d+)\/?/)) {
    const ruleset = m[2];
    update_selected_ruleset(ruleset);

    const user_id = m[1];
    const page_num = m[3] || 1;
    document.querySelector('main').innerHTML = '';
    await render_user(user_id, page_num);
  } else if (m = new_url.match(/\/u\/(\d+)\/(\w+)\/?/)) {
    const ruleset = m[2];
    update_selected_ruleset(ruleset);

    const user_id = m[1];
    document.querySelector('main').innerHTML = '';
    await render_user(user_id, 1);
  } else if (m = new_url.match(/\/leaderboard\/(page-(\d+)\/)?/)) {
    const page_num = m[2] || 1;
    new_url = `/leaderboard/${rulesets[selected_ruleset]}/page-${page_num}/`;
    window.history.replaceState({}, 'osu! ranked lobbies', new_url);
    route(new_url);
  } else if (m = new_url.match(/\/u\/(\d+)\/?/)) {
    new_url = `/u/${m[1]}/${rulesets[selected_ruleset]}/`;
    window.history.replaceState({}, 'osu! ranked lobbies', new_url);
    route(new_url);
  } else {
    const main = document.querySelector('main');
    if (main.innerHTML.indexOf('{{ error }}') != -1) {
      main.innerHTML = 'Page not found.';
    }
  }

  const links = document.querySelectorAll('a');
  for (const link of links) {
    link.removeEventListener('click', click_listener);
  }
  for (const link of links) {
    link.addEventListener('click', click_listener);
  }

  const radios = document.querySelectorAll('.radio-area');
  for (const area of radios) {
    area.addEventListener('click', function() {
      this.querySelector('input[type="radio"]').click();
    });
  }
}


// Load pages and hijack browser browsing
route(location.pathname);
