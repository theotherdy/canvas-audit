@extends('layouts.app')

@section('content')
<div class="container mt-4">
    <h1 class="h5 mb-3">Audit results</h1>

    @if ($hasErrors)
        <div class="alert alert-warning">
            Some courses returned errors – see the "Error" column.
        </div>
    @endif

    <div class="table-responsive">
        <table class="table table-sm table-bordered align-middle">
            <thead class="table-light">
                <tr>
                    <th>Course</th>
                    <th>Pages</th>
                    <th>Classic Q.</th>
                    <th>New Q.</th>
                    <th>Other<br>Assign.</th>
                    <th>Discussions</th>
                    <th>Active<br>Students</th>
                    <th>Quiz Eng.</th>
                    <th>Assign Eng.</th>
                    <th>Disc. Eng.</th>
                    <th>Duration</th>
                    <th>Error</th>
                </tr>
            </thead>
            <tbody>
                @foreach ($results as $r)
                    <tr class="{{ isset($r->error) ? 'table-danger' : '' }}">
                        <td>{{ $r->course_id }}</td>
                        <td>{{ $r->published_pages }}</td>
                        <td>{{ $r->classic_quizzes }}</td>
                        <td>{{ $r->new_quizzes }}</td>
                        <td>{{ $r->other_assignments }}</td>
                        <td>{{ $r->discussions }}</td>
                        <td>{{ $r->active_students }}</td>
                        <td>{{ num($r->quiz_engagement) }}</td>
                        <td>{{ num($r->assignment_engagement) }}</td>
                        <td>{{ num($r->discussion_engagement) }}</td>
                        <td>{{ isset($r->audit_duration) ? $r->audit_duration . 's' : '—' }}</td>
                        <td class="text-wrap" style="max-width:15rem;">
                            @if(isset($r->error))
                                <small class="text-danger">{{ $r->error }}</small>
                            @endif
                        </td>
                    </tr>
                @endforeach
            </tbody>
        </table>
    </div>

    <div class="mt-3">
        <a href="{{ route('audit.home') }}" class="btn btn-secondary">Back</a>
        <a href="{{ route('debug.index') }}" class="btn btn-outline-info">Debug Tools</a>
    </div>
</div>
@endsection

@php
/** helper to format ratios as 0.0 % */
function num($v) { return $v ? number_format($v * 100, 1) . '%' : '—'; }
@endphp
