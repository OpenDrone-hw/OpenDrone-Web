import team from '../../content/team.json';

/** The people who design, support and ship OpenDrone, from content/team.json. */
export function TeamStrip() {
  return (
    <ul className="team-strip">
      {team.people.map((person) => (
        <li key={person.name}>
          <img src={person.img} alt="" width={160} height={160} loading="lazy" decoding="async" />
          <strong>{person.name}</strong>
          <span>{person.role}</span>
        </li>
      ))}
    </ul>
  );
}
