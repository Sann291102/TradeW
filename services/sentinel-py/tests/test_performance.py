from app.strategy.performance import MEANINGFUL_SAMPLE, compute_performance


def watch(wid, entry=None, state="IDLE"):
    return {"id": wid, "state": state, "entryPrice": entry, "strategyId": "s1"}


def obs(at, state="FORMING", agent="watch-engine", metadata=None, findings=None):
    return {
        "id": f"o-{at}",
        "agent": agent,
        "state": state,
        "createdAt": at,
        "candleTime": None,
        "ruleEvaluations": findings or [],
        "metadata": metadata or {},
    }


def in_trade(at, r, event=None):
    findings = [{"event": event, "detail": "", "milestone": None}] if event else []
    return obs(at, state="IN_TRADE", agent="intrade-monitor", metadata={"rMultiple": r}, findings=findings)


def test_empty_strategy_reports_zeros_not_errors():
    result = compute_performance("s1", [], {})
    assert result.funnel.watches == 0
    assert result.r.expectancy is None
    assert result.sufficient is False


def test_funnel_counts_the_stage_each_watch_reached():
    watches = [watch("w1"), watch("w2"), watch("w3", entry=100)]
    observations = {
        "w1": [obs("t2", state="FORMING")],
        "w2": [obs("t2", state="CONFIRMED")],
        "w3": [in_trade("t3", 1.0, "projected_level_reached"), obs("t2", state="CONFIRMED")],
    }
    f = compute_performance("s1", watches, observations).funnel
    assert f.watches == 3
    assert f.interactions == 3
    assert f.confirmations == 2  # w1 only ever formed
    assert f.entries == 1
    assert f.outcomes == 1


def test_a_closed_watch_still_counts_its_earlier_stages():
    """Reading only the CURRENT state would report zero of everything the
    moment a trade closes."""
    watches = [watch("w1", entry=100, state="EXITED")]
    observations = {"w1": [in_trade("t3", -1.0, "invalidation_reached"), obs("t1", state="CONFIRMED")]}
    f = compute_performance("s1", watches, observations).funnel
    assert (f.interactions, f.confirmations, f.entries, f.outcomes) == (1, 1, 1, 1)


def test_expectancy_uses_the_final_reading_and_excursions_use_the_extremes():
    watches = [watch("w1", entry=100)]
    observations = {
        "w1": [
            in_trade("t4", 1.5, "projected_level_reached"),  # newest / final
            in_trade("t3", 2.4),                             # ran to +2.4 first
            in_trade("t2", -0.6),                            # and against to -0.6
            obs("t1", state="CONFIRMED"),
        ]
    }
    r = compute_performance("s1", watches, observations).r
    assert r.completed == 1
    assert r.expectancy == 1.5   # what the trade finished at
    assert r.avgMfe == 2.4       # best it ever showed
    assert r.avgMae == -0.6      # worst it ever showed


def test_an_open_position_is_not_counted_as_an_outcome():
    watches = [watch("w1", entry=100)]
    observations = {"w1": [in_trade("t2", 0.8), obs("t1", state="CONFIRMED")]}
    result = compute_performance("s1", watches, observations)
    assert result.outcomes.stillOpen == 1
    assert result.funnel.outcomes == 0
    assert result.r.completed == 0


def test_outcomes_split_by_which_level_was_reached():
    watches = [watch("w1", entry=100), watch("w2", entry=100)]
    observations = {
        "w1": [in_trade("t2", 2.0, "projected_level_reached")],
        "w2": [in_trade("t2", -1.0, "invalidation_reached")],
    }
    o = compute_performance("s1", watches, observations).outcomes
    assert (o.reachedProjected, o.reachedInvalidation) == (1, 1)


def test_small_samples_are_flagged_rather_than_presented_as_a_rate():
    """A 90% win rate off two trades misleads more than silence would."""
    watches = [watch(f"w{i}", entry=100) for i in range(2)]
    observations = {f"w{i}": [in_trade("t2", 1.0, "projected_level_reached")] for i in range(2)}
    result = compute_performance("s1", watches, observations)
    assert result.r.completed == 2
    assert result.sufficient is False
    assert str(MEANINGFUL_SAMPLE) in result.note


def test_a_full_sample_is_marked_sufficient_with_no_caveat():
    watches = [watch(f"w{i}", entry=100) for i in range(MEANINGFUL_SAMPLE)]
    observations = {
        f"w{i}": [in_trade("t2", 1.0, "projected_level_reached")] for i in range(MEANINGFUL_SAMPLE)
    }
    result = compute_performance("s1", watches, observations)
    assert result.sufficient is True
    assert result.note == ""


def test_rejections_reuse_the_feed_definition():
    """The funnel's count and the feed's events must never disagree."""
    met = {"ruleId": "r1", "name": "breakout", "mandatory": True, "met": True, "detail": ""}
    lost = {"ruleId": "r1", "name": "breakout", "mandatory": True, "met": False, "detail": "gone"}
    watches = [watch("w1")]
    observations = {
        "w1": [
            obs("t3", findings=[lost], metadata={"mandatoryMet": 0, "mandatoryTotal": 1}),
            obs("t2", findings=[met], metadata={"mandatoryMet": 1, "mandatoryTotal": 1}),
        ]
    }
    assert compute_performance("s1", watches, observations).funnel.rejections == 1


def test_skipped_sweeps_do_not_inflate_rejections():
    met = {"ruleId": "r1", "name": "breakout", "mandatory": True, "met": True, "detail": ""}
    watches = [watch("w1")]
    observations = {
        "w1": [
            obs("t3", findings=[met], metadata={"mandatoryMet": 1, "mandatoryTotal": 1}),
            obs("t2", metadata={"skipped": "market_data_unavailable"}),
            obs("t1", findings=[met], metadata={"mandatoryMet": 1, "mandatoryTotal": 1}),
        ]
    }
    assert compute_performance("s1", watches, observations).funnel.rejections == 0
