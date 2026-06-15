alter table public.posts
  add column if not exists username text not null default '匿名'
    check (char_length(username) between 1 and 20),
  add column if not exists avatar text not null default 'longnose'
    check (avatar in (
      'longnose',
      'roundears',
      'firebox',
      'oneeye',
      'boxhead',
      'snail'
    ));
