from app.watch.timeline import build_timeline

WATCH = {
    "id": "watch_1",
    "symbol": "NIFTY",
    "strike": "24350",
    "optionType": "PE",
    "expiry": "2026-08-21",
    "state": "IN_TRADE",
    "direction": "SHORT",
    "strategyId": "strat_1",
}


def observation(created_at, agent="watch-engine", state="FORMING", metadata=None, findings=None):
    return {
        "id": f"obs-{created_at}",
        "agent": agent,
        "state": state,
        "createdAt": created_at,
        "candleTime": None,
        "ruleEvaluations": findings or [],
        "metadata": metadata or {},
    }


def test_forming_strength_is_the_real_condition_ratio():
    obs = [observation("2026-08-13T10:00:00", metadata={"mandatoryMet": 1, "mandatoryTotal": 2})]
    events = build_timeline(WATCH, obs)["events"]
    assert events[0]["kind"] == "wait_and_watch"
    assert events[0]["strength"] == 0.5
    assert events[0]["conditionsMet"] == 1


def test_confirmed_is_full_strength():
    obs = [
        observation(
            "2026-08-13T10:30:00", state="CONFIRMED", metadata={"mandatoryMet": 2, "mandatoryTotal": 2}
        )
    ]
    events = build_timeline(WATCH, obs)["events"]
    assert events[0]["kind"] == "confirmed"
    assert events[0]["strength"] == 1.0


def test_idle_observations_never_reach_the_feed():
    obs = [observation("2026-08-13T09:20:00", state="IDLE", metadata={"mandatoryMet": 0, "mandatoryTotal": 2})]
    assert build_timeline(WATCH, obs)["events"] == []


def test_skipped_sweeps_are_left_in_the_audit_trail_not_the_feed():
    obs = [observation("2026-08-13T09:20:00", metadata={"skipped": "market_data_unavailable"})]
    assert build_timeline(WATCH, obs)["events"] == []


def test_milestones_map_to_distinct_kinds_and_are_never_predictions():
    obs = [
        observation(
            "2026-08-13T11:00:00",
            agent="intrade-monitor",
            state="IN_TRADE",
            metadata={"rMultiple": 2.4},
            findings=[{"event": "milestone", "milestone": "2R", "detail": "moved 2:1"}],
        )
    ]
    event = build_timeline(WATCH, obs)["events"][0]
    assert event["kind"] == "milestone_2R"
    assert event["strength"] == 1.0
    assert event["rMultiple"] == 2.4


def test_one_observation_can_yield_several_in_trade_events():
    obs = [
        observation(
            "2026-08-13T11:15:00",
            agent="intrade-monitor",
            state="IN_TRADE",
            findings=[
                {"event": "milestone", "milestone": "1R", "detail": "moved 1:1"},
                {"event": "structure_break", "milestone": None, "detail": "structure shifting"},
            ],
        )
    ]
    kinds = [e["kind"] for e in build_timeline(WATCH, obs)["events"]]
    assert set(kinds) == {"milestone_1R", "structure_break"}


def test_feed_is_newest_first_regardless_of_input_order():
    obs = [
        observation("2026-08-13T10:00:00", metadata={"mandatoryMet": 1, "mandatoryTotal": 2}),
        observation("2026-08-13T12:00:00", metadata={"mandatoryMet": 1, "mandatoryTotal": 2}),
        observation("2026-08-13T11:00:00", metadata={"mandatoryMet": 1, "mandatoryTotal": 2}),
    ]
    times = [e["at"] for e in build_timeline(WATCH, obs)["events"]]
    assert times == sorted(times, reverse=True)


def test_watch_block_carries_what_the_feed_needs_to_label_direction():
    result = build_timeline(WATCH, [])
    assert result["watch"]["symbol"] == "NIFTY"
    assert result["watch"]["strike"] == "24350"
    assert result["watch"]["optionType"] == "PE"
    assert result["watch"]["direction"] == "SHORT"


# --- run collapsing ---------------------------------------------------------


def forming(at, met=1, total=2):
    return observation(at, metadata={"mandatoryMet": met, "mandatoryTotal": total})


def test_a_run_of_identical_states_collapses_to_one_entry():
    """The sweep re-checks every 15s; forty 'still forming' rows is one state
    the user is in, not forty things that happened."""
    obs = [forming(f"2026-08-13T10:{m:02d}:00") for m in range(10, 20)]
    events = build_timeline(WATCH, obs)["events"]
    assert len(events) == 1
    assert events[0]["occurrences"] == 10
    assert events[0]["at"] == "2026-08-13T10:19:00"       # latest reading
    assert events[0]["firstAt"] == "2026-08-13T10:10:00"  # run started here


def test_distinct_states_are_not_merged():
    obs = [
        forming("2026-08-13T10:00:00"),
        observation("2026-08-13T10:30:00", state="CONFIRMED", metadata={"mandatoryMet": 2, "mandatoryTotal": 2}),
    ]
    kinds = [e["kind"] for e in build_timeline(WATCH, obs)["events"]]
    assert kinds == ["confirmed", "wait_and_watch"]


def test_a_state_the_watch_returns_to_stays_a_separate_spell():
    """FORMING -> CONFIRMED -> FORMING is two spells, not one merged run."""
    obs = [
        forming("2026-08-13T10:00:00"),
        observation("2026-08-13T10:15:00", state="CONFIRMED", metadata={"mandatoryMet": 2, "mandatoryTotal": 2}),
        forming("2026-08-13T10:30:00"),
    ]
    kinds = [e["kind"] for e in build_timeline(WATCH, obs)["events"]]
    assert kinds == ["wait_and_watch", "confirmed", "wait_and_watch"]


def test_single_events_still_report_one_occurrence():
    events = build_timeline(WATCH, [forming("2026-08-13T10:00:00")])["events"]
    assert events[0]["occurrences"] == 1
    assert events[0]["firstAt"] == events[0]["at"]
