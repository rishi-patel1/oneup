-- Friendly defaults are display names, not identifiers; duplicates are welcome.
create or replace function numora_private.playful_profile_name()
returns text language plpgsql volatile security invoker set search_path='' as $$
declare
  v_adjectives constant text[] := array[
    'Pedantic','Hungry','Angry','Wobbly','Dramatic','Suspicious','Curious','Sleepy',
    'Bouncy','Cheeky','Dizzy','Fancy','Fidgety','Fluffy','Grumpy','Happy',
    'Jolly','Loopy','Lucky','Mighty','Mischievous','Moody','Nimble','Odd',
    'Peppy','Plucky','Puzzled','Quirky','Rowdy','Sassy','Shifty','Silly',
    'Snazzy','Sneaky','Snuggly','Spicy','Squishy','Stubborn','Sunny','Ticklish',
    'Twinkly','Unruly','Wacky','Wandering','Whimsical','Wiggly','Zany','Zen',
    'Awkward','Bashful','Bold','Bumbling','Caffeinated','Chaotic','Goofy','Overcooked'
  ];
  v_nouns constant text[] := array[
    'Stonebreaker','Kallam','Goose','Wombat','Teapot','Pancake','Badger','Biscuit',
    'Broccoli','Bubble','Burrito','Cabbage','Capybara','Cheesecake','Chinchilla','Chipmunk',
    'Coconut','Crumpet','Cupcake','Dumpling','Ferret','Flamingo','Flapjack','Goblin',
    'Hedgehog','Hippo','Jellybean','Kangaroo','Kiwi','Koala','Llama','Macaroni',
    'Marshmallow','Meatball','Muffin','Noodle','Nugget','Otter','Panda','Parsnip',
    'Penguin','Pickle','Platypus','Potato','Pretzel','Puffin','Raccoon','Radish',
    'Ravioli','Sausage','Sloth','Spoon','Taco','Turnip','Walrus','Waffle'
  ];
begin
  return v_adjectives[1+floor(random()*cardinality(v_adjectives))::integer]
    || v_nouns[1+floor(random()*cardinality(v_nouns))::integer];
end;
$$;
revoke execute on function numora_private.playful_profile_name() from public,anon,authenticated,service_role;

create or replace function numora_private.daily_profile()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_user(); v_code text; v_at integer;
begin
  if not numora_private.is_google_user(v_user) then return null; end if;
  if not exists(select 1 from numora_private.profiles where user_id=v_user) then
    for v_at in 1..10 loop
      v_code := upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
      begin
        insert into numora_private.profiles(user_id,display_name,friend_code)
          values(v_user,numora_private.playful_profile_name(),v_code)
          on conflict (user_id) do nothing;
        exit;
      exception when unique_violation then
        if v_at=10 then raise exception 'Could not allocate a friend code. Please try again.'; end if;
      end;
    end loop;
  end if;
  return (select jsonb_build_object('id',user_id,'display_name',display_name,'friend_code',friend_code)
    from numora_private.profiles where user_id=v_user);
end;
$$;
revoke execute on function numora_private.daily_profile() from public,anon,authenticated,service_role;

-- Exact old defaults with unchanged timestamps are the only proven untouched
-- names. Preserve edited names, including later manual resets to the old text.
update numora_private.profiles
  set display_name=numora_private.playful_profile_name(),updated_at=clock_timestamp()
  where display_name='Player ' || right(friend_code,6) and updated_at=created_at;

notify pgrst,'reload schema';
